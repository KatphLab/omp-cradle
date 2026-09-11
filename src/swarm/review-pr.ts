import * as fs from 'node:fs/promises'
import path from 'node:path'
import { parseSwarmYaml, type SwarmDefinition } from './swarm/schema'

export interface PrReview {
  number: string
  validate: boolean
  workspace: string
  resolvedPath: string
  content: string
  definition: SwarmDefinition
}

async function commandOutput(argv: string[], cwd: string): Promise<string> {
  const child = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    const command = argv.at(0) ?? 'command'
    const detail = stderr.trim() || ['exit', exitCode].join(' ')
    throw new Error([command, 'failed', detail].join(' '))
  }
  return stdout
}

export async function preparePrReview(arguments_: string[]): Promise<PrReview> {
  const [number, option] = arguments_
  if (
    number === undefined ||
    !/^[1-9]\d*$/.test(number) ||
    !Number.isSafeInteger(Number(number)) ||
    arguments_.length > 2 ||
    (option !== undefined && option !== '--validate')
  ) {
    throw new Error(
      'Usage: omp-swarm review-pr <positive-safe-integer> [--validate]',
    )
  }
  const workspaceOutput = await commandOutput(
    ['git', 'rev-parse', '--show-toplevel'],
    process.cwd(),
  )
  const workspace = workspaceOutput.replace(/\r?\n$/, '')
  const resolvedPath = path.join(
    workspace,
    '.omp-swarm',
    `review-pr-${number}`,
    'workflow.yaml',
  )
  const template = await fs.readFile(
    new URL('workflows/review-pr.yaml', import.meta.url),
    'utf8',
  )
  const content = template
    .replaceAll('__PR_NUMBER__', number)
    .replace(/^ {2}workspace: \.$/m, () =>
      ['  workspace: ', JSON.stringify(workspace)].join(''),
    )
  const definition = parseSwarmYaml(content)
  definition.sourcePath = resolvedPath
  definition.sourceDir = path.dirname(resolvedPath)
  if (definition.workspace !== workspace) {
    throw new Error('Packaged PR review workspace did not roundtrip correctly')
  }
  return {
    number,
    validate: option === '--validate',
    workspace,
    resolvedPath,
    content,
    definition,
  }
}

export async function verifyPrReview(review: PrReview): Promise<void> {
  if (await Bun.file(review.resolvedPath).exists()) {
    throw new Error(
      `Review workflow already exists; use omp-swarm restart ${JSON.stringify(review.resolvedPath)}`,
    )
  }
  const status = await commandOutput(
    ['git', 'status', '--porcelain', '--untracked-files=all'],
    review.workspace,
  )
  if (status.length > 0) {
    throw new Error(
      'PR review requires a clean working tree, including untracked files',
    )
  }
  const prOutput = await commandOutput(
    [
      'gh',
      'pr',
      'view',
      review.number,
      '--json',
      'headRefOid,state,number,url',
    ],
    review.workspace,
  )
  const parsed: unknown = JSON.parse(prOutput)
  if (!isPullRequest(parsed, review.number)) {
    throw new Error('PR review requires the requested OPEN GitHub pull request')
  }
  const headOutput = await commandOutput(
    ['git', 'rev-parse', 'HEAD'],
    review.workspace,
  )
  const head = headOutput.trim()
  if (head !== parsed.headRefOid) {
    throw new Error(
      'Check out the PR HEAD before running review-pr; no checkout was performed',
    )
  }
}

function isPullRequest(
  value: unknown,
  number: string,
): value is { headRefOid: string } {
  if (typeof value !== 'object' || value === null) return false
  if (!('state' in value) || value.state !== 'OPEN') return false
  if (!('number' in value) || value.number !== Number(number)) return false
  return 'headRefOid' in value && typeof value.headRefOid === 'string'
}

export async function persistPrReview(review: PrReview): Promise<void> {
  await fs.mkdir(path.dirname(review.resolvedPath), { recursive: true })
  await fs.writeFile(review.resolvedPath, review.content, { flag: 'wx' })
}
