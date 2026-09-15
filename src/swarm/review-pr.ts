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
    const detail = stderr.trim() || `exit ${exitCode}`
    throw new Error(`${command} failed ${detail}`)
  }
  return stdout
}

export async function preparePrReview(arguments_: string[]): Promise<PrReview> {
  const [number, ...options] = arguments_
  if (
    number === undefined ||
    !/^[1-9]\d*$/.test(number) ||
    !Number.isSafeInteger(Number(number)) ||
    new Set(options).size !== options.length ||
    options.some(
      (option) => option !== '--validate' && option !== '--report-only',
    )
  ) {
    throw new Error(
      'Usage: omp-swarm review-pr <positive-safe-integer> [--validate] [--report-only]',
    )
  }
  const reportOnly = options.includes('--report-only')
  const workspaceOutput = await commandOutput(
    ['git', 'rev-parse', '--show-toplevel'],
    process.cwd(),
  )
  const workspace = await fs.realpath(workspaceOutput.replace(/\r?\n$/, ''))
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
  let content = template
    .replaceAll('__PR_NUMBER__', number)
    .replaceAll('__REVIEW_MODE__', reportOnly ? 'report-only' : 'fix')
    .replace(
      /^ {2}workspace: \.$/m,
      () => `  workspace: ${JSON.stringify(workspace)}`,
    )
  if (reportOnly) content = reportOnlyYaml(content)
  const definition = parseSwarmYaml(content)
  definition.sourcePath = resolvedPath
  definition.sourceDir = path.dirname(resolvedPath)
  if (definition.workspace !== workspace) {
    throw new Error('Packaged PR review workspace did not roundtrip correctly')
  }
  return {
    number,
    validate: options.includes('--validate'),
    workspace,
    resolvedPath,
    content,
    definition,
  }
}

function isReviewYamlMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function reportOnlyYaml(content: string): string {
  const document = Bun.YAML.parse(content)
  if (
    !isReviewYamlMapping(document) ||
    !isReviewYamlMapping(document['swarm']) ||
    !isReviewYamlMapping(document['swarm']['nodes']) ||
    !isReviewYamlMapping(document['swarm']['nodes']['adjudicate']) ||
    !isReviewYamlMapping(document['swarm']['nodes']['adjudicate']['resume'])
  ) {
    throw new Error(
      'Packaged PR review expected YAML mappings and adjudicate resume',
    )
  }
  const nodes = document['swarm']['nodes']
  document['swarm']['nodes']['adjudicate']['resume']['policy'] = 'never'
  delete nodes['implementer']
  delete nodes['verify']
  delete nodes['acceptance']
  return Bun.YAML.stringify(document, undefined, 2)
}

export async function verifyPrReview(review: PrReview): Promise<void> {
  const runtime = await fs
    .lstat(path.join(review.workspace, `.swarm_review-pr-${review.number}`))
    .catch((error_: unknown) => {
      if (
        error_ instanceof Error &&
        'code' in error_ &&
        error_.code === 'ENOENT'
      ) {
        return
      }
      throw new Error('Cannot inspect PR review runtime artifacts', {
        cause: error_,
      })
    })
  if (runtime !== undefined) {
    throw new Error(
      'PR review runtime artifacts already exist; inspect them before explicitly restarting the existing review workflow',
    )
  }
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
  const workspace = await fs.realpath(review.workspace)
  const relativePath = path.relative(workspace, review.resolvedPath)
  if (
    workspace !== review.workspace ||
    relativePath !==
      path.join('.omp-swarm', `review-pr-${review.number}`, 'workflow.yaml')
  ) {
    throw new Error('Review workflow must be inside the canonical workspace')
  }
  let directory = workspace
  for (const component of path.dirname(relativePath).split(path.sep)) {
    directory = path.join(directory, component)
    try {
      const stat = await fs.lstat(directory)
      if (!stat.isDirectory()) {
        throw new Error('Review workflow ancestors must be real directories')
      }
    } catch (error_) {
      if (
        error_ instanceof Error &&
        'code' in error_ &&
        error_.code === 'ENOENT'
      ) {
        break
      }
      throw new Error('Cannot inspect review workflow ancestors', {
        cause: error_,
      })
    }
  }
  await fs.mkdir(path.dirname(review.resolvedPath), { recursive: true })
  await fs.writeFile(review.resolvedPath, review.content, { flag: 'wx' })
}
