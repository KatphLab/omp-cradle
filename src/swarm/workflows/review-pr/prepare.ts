import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { parseSwarmYaml, type SwarmDefinition } from '../../swarm/schema'
import { writeWorkspaceSignal } from '../../swarm/signal-tool-context'

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
    child.stdout.text(),
    child.stderr.text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    const detail = stderr.trim() || `exit ${exitCode}`
    throw new Error(`${argv[0] ?? 'Command'} failed: ${detail}`)
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
    options.some((option) => option !== '--validate')
  ) {
    throw new Error(
      'Usage: omp-swarm review-pr <positive-safe-integer> [--validate]; reviews are always report-only',
    )
  }
  const rootOutput = await commandOutput(
    ['git', 'rev-parse', '--show-toplevel'],
    process.cwd(),
  )
  const workspace = await fs.realpath(rootOutput.trimEnd())
  const resolvedPath = path.join(
    workspace,
    '.omp-swarm',
    `review-pr-${number}`,
    'workflow.yaml',
  )
  const template = await fs.readFile(
    new URL('workflow.yaml', import.meta.url),
    'utf8',
  )
  const content = template
    .replaceAll('__PR_NUMBER__', number)
    .replace(
      /^ {2}workspace: \.$/m,
      () => `  workspace: ${JSON.stringify(workspace)}`,
    )
  const definition = parseSwarmYaml(content)
  definition.sourcePath = resolvedPath
  definition.sourceDir = path.dirname(resolvedPath)
  assert.equal(definition.workspace, workspace)
  return {
    number,
    validate: options.includes('--validate'),
    workspace,
    resolvedPath,
    content,
    definition,
  }
}

export async function assertReviewSource(
  workspace: string,
  swarmName: string,
  head: string,
): Promise<void> {
  const rootOutput = await commandOutput(
    ['git', 'rev-parse', '--show-toplevel'],
    workspace,
  )
  const headOutput = await commandOutput(
    ['git', 'rev-parse', 'HEAD'],
    workspace,
  )
  assert.equal(rootOutput.trimEnd(), workspace, 'Review repository changed')
  assert.equal(
    headOutput.trim(),
    head,
    'Review HEAD changed; start a fresh review',
  )
  const status = await commandOutput(
    ['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    workspace,
  )
  const artifactRoot = `.omp-swarm/${swarmName}/`
  for (const entry of status.split('\0').filter(Boolean)) {
    const name = entry.slice(3)
    const artifact =
      name.startsWith(`${artifactRoot}run/`) ||
      name === `${artifactRoot}workflow.yaml` ||
      name.startsWith(`.swarm_${swarmName}/`) ||
      ['signals/', 'tracking/', 'reports/', 'output/'].some((prefix) =>
        name.startsWith(prefix),
      )
    assert.ok(
      entry.startsWith('?? ') && artifact,
      'Review source or index changed; restore a clean checkout before reviewing',
    )
  }
}

async function readPullRequest(
  workspace: string,
  number: string,
  repository: string,
) {
  const value: unknown = JSON.parse(
    await commandOutput(
      [
        'gh',
        'pr',
        'view',
        number,
        '--repo',
        repository,
        '--json',
        'number,state,url,baseRefOid,headRefOid',
      ],
      workspace,
    ),
  )
  assert.ok(typeof value === 'object' && value !== null, 'Missing PR metadata')
  assert.ok(
    'number' in value && value.number === Number(number),
    'Wrong PR number',
  )
  assert.ok('state' in value && value.state === 'OPEN', 'PR must be OPEN')
  assert.ok('url' in value && typeof value.url === 'string', 'Missing PR URL')
  assert.ok(
    'baseRefOid' in value && typeof value.baseRefOid === 'string',
    'Missing PR base',
  )
  assert.ok(
    'headRefOid' in value && typeof value.headRefOid === 'string',
    'Missing PR head',
  )
  assert.match(value.baseRefOid, /^[\da-f]{40}$/)
  assert.match(value.headRefOid, /^[\da-f]{40}$/)
  return { base: value.baseRefOid, head: value.headRefOid, url: value.url }
}

export async function persistPrReview(review: PrReview): Promise<void> {
  const { workspace, number } = review
  const swarmName = `review-pr-${number}`
  const root = `.omp-swarm/${swarmName}`
  assert.equal(await fs.realpath(workspace), workspace)
  assert.equal(review.resolvedPath, path.join(workspace, root, 'workflow.yaml'))
  for (const destination of [root, `.swarm_${swarmName}`]) {
    const existing = await fs
      .lstat(path.join(workspace, destination))
      .catch((error_: unknown) => {
        if (
          error_ instanceof Error &&
          'code' in error_ &&
          error_.code === 'ENOENT'
        )
          return
        throw new Error('Cannot inspect existing review artifacts', {
          cause: error_,
        })
      })
    assert.equal(
      existing,
      undefined,
      'Review artifacts already exist; preserve them and use a separate clean checkout for a fresh review',
    )
  }
  assert.equal(
    await commandOutput(
      ['git', 'status', '--porcelain=v1', '--untracked-files=all'],
      workspace,
    ),
    '',
    'PR review requires a clean working tree, including untracked files',
  )
  const { freeze, patch } = await freezeReview(workspace, number, swarmName)
  for (const [name, content] of [
    ['pr.patch', patch],
    ['freeze.yaml', Bun.YAML.stringify(freeze)],
  ] as const) {
    const destination = `${root}/run/${name}`
    await writeWorkspaceSignal(workspace, destination, content)
    assert.equal(
      await Bun.file(path.join(workspace, destination)).text(),
      content,
    )
  }
  await writeWorkspaceSignal(workspace, `${root}/workflow.yaml`, review.content)
}

async function freezeReview(
  workspace: string,
  number: string,
  swarmName: string,
) {
  const repository: unknown = JSON.parse(
    await commandOutput(
      ['gh', 'repo', 'view', '--json', 'id,nameWithOwner,url'],
      workspace,
    ),
  )
  assert.ok(
    typeof repository === 'object' &&
      repository !== null &&
      'id' in repository &&
      typeof repository.id === 'string' &&
      'nameWithOwner' in repository &&
      typeof repository.nameWithOwner === 'string' &&
      'url' in repository &&
      typeof repository.url === 'string',
    'Cannot resolve GitHub repository identity',
  )
  const host = new URL(repository.url).host
  const qualifiedRepository = `${host}/${repository.nameWithOwner}`
  const pr = await readPullRequest(workspace, number, qualifiedRepository)
  await assertReviewSource(workspace, swarmName, pr.head)
  const mergeBaseOutput = await commandOutput(
    ['git', 'merge-base', pr.base, pr.head],
    workspace,
  )
  const mergeBase = mergeBaseOutput.trim()
  const diff = ['git', 'diff', '--no-ext-diff', '--no-textconv']
  const patch = await commandOutput(
    [...diff, '--binary', mergeBase, pr.head],
    workspace,
  )
  const pathsOutput = await commandOutput(
    [...diff, '--name-only', '--no-renames', '-z', mergeBase, pr.head],
    workspace,
  )
  const paths = pathsOutput.split('\0').filter(Boolean)
  assert.deepEqual(
    await readPullRequest(workspace, number, qualifiedRepository),
    pr,
    'PR changed during preflight; start again',
  )
  await assertReviewSource(workspace, swarmName, pr.head)
  const freeze = {
    schema: 1,
    producer: 'preflight',
    status: 'READY',
    root: workspace,
    identity: {
      run_id: randomUUID(),
      repository_id: repository.id,
      repository: repository.nameWithOwner,
      host,
      pr: Number(number),
      base: pr.base,
      head: pr.head,
      merge_base: mergeBase,
    },
    pr_url: pr.url,
    paths,
  }
  return { freeze, patch }
}
