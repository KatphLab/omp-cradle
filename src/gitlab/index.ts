import type { ExtensionAPI } from '@oh-my-pi/pi-coding-agent'
import { realpath } from 'node:fs/promises'
import path from 'node:path'

interface MergeRequestParameters {
  cwd: string
  repo: string
  sourceBranch: string
  targetBranch: string
  title: string
  description: string
}

interface GitLabOrigin {
  hostname: string
  repo: string
}

function parseOrigin(origin: string): GitLabOrigin {
  let hostname: string
  let path: string
  if (origin.includes('://')) {
    let url: URL
    try {
      url = new URL(origin)
    } catch {
      throw new Error('Origin must be a GitLab HTTPS or SSH repository URL')
    }
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) {
      throw new Error('Origin must be a GitLab HTTPS or SSH repository URL')
    }
    hostname = url.protocol === 'ssh:' ? url.hostname : url.host
    path = url.pathname.slice(1)
  } else {
    const separator = origin.indexOf(':')
    const authority = origin.slice(0, separator)
    hostname = authority.slice(authority.lastIndexOf('@') + 1)
    path = separator === -1 ? '' : origin.slice(separator + 1)
  }
  const repo = path.replace(/\.git$/u, '')
  if (!hostname || !repo.includes('/')) {
    throw new Error('Origin must identify a GitLab namespace and project')
  }
  return { hostname, repo }
}

type RunCommand = (
  command: 'git' | 'glab',
  args: string[],
  operation: string,
) => Promise<string>

async function readWorktree(
  run: RunCommand,
  parameters: MergeRequestParameters,
) {
  if (!path.isAbsolute(parameters.cwd)) {
    throw new Error('cwd must be the absolute owning Git worktree root')
  }
  const root = await run(
    'git',
    ['rev-parse', '--show-toplevel'],
    'Resolve worktree',
  )
  if ((await realpath(parameters.cwd)) !== (await realpath(root))) {
    throw new Error(
      'cwd must be the owning Git worktree root, not a subdirectory',
    )
  }
  const source = await run(
    'git',
    ['branch', '--show-current'],
    'Read current branch',
  )
  if (source !== parameters.sourceBranch) {
    throw new Error(
      'Current branch differs from sourceBranch; select the owning worktree and its current branch',
    )
  }
  const sha = await run(
    'git',
    ['rev-parse', '--verify', 'HEAD'],
    'Read local HEAD',
  )
  const origin = parseOrigin(
    await run('git', ['remote', 'get-url', 'origin'], 'Read origin'),
  )
  return { sha, origin }
}

function commandRunner(
  pi: ExtensionAPI,
  cwd: string,
  signal: AbortSignal | undefined,
): RunCommand {
  return async (command, args, operation) => {
    let result
    try {
      result = await pi.exec(command, args, {
        cwd,
        timeout: 30_000,
        ...(signal === undefined ? {} : { signal }),
      })
    } catch {
      throw new Error(
        `${operation} could not run. Check ${command} installation and authentication; do not retry MR creation without checking for an existing MR.`,
      )
    }
    if (result.killed || result.code !== 0) {
      const outcome = result.killed
        ? 'cancelled or timed out'
        : `exit ${result.code}`
      throw new Error(
        `${operation} failed (${outcome}). Check the owning worktree, GitLab authentication, and branch availability. If creation was attempted, check for an existing MR before retrying.`,
      )
    }
    return result.stdout.trim()
  }
}

type GitLabAPI = (
  endpoint: string,
  method?: 'GET' | 'POST',
  fields?: string[],
) => Promise<unknown>

async function checkProjectBranches(
  pi: ExtensionAPI,
  api: GitLabAPI,
  parameters: MergeRequestParameters,
  originRepo: string,
  sha: string,
) {
  const projectSchema = pi.zod.object({
    id: pi.zod.number().int().positive(),
    path_with_namespace: pi.zod.string(),
  })
  const branchSchema = pi.zod.object({
    commit: pi.zod.object({ id: pi.zod.string() }),
  })
  const project = projectSchema.parse(
    await api(`projects/${encodeURIComponent(parameters.repo)}`),
  )
  const originProject = projectSchema.parse(
    await api(`projects/${encodeURIComponent(originRepo)}`),
  )
  if (project.path_with_namespace !== parameters.repo) {
    throw new Error(
      `Use the canonical repo path: ${project.path_with_namespace}`,
    )
  }
  if (originProject.id !== project.id) {
    throw new Error(
      'Requested repo does not own this worktree origin. Use the canonical repo for origin; fork MRs are not supported.',
    )
  }
  const endpoint = `projects/${project.id}`
  const remoteSource = branchSchema.parse(
    await api(
      `${endpoint}/repository/branches/${encodeURIComponent(parameters.sourceBranch)}`,
    ),
  )
  if (remoteSource.commit.id !== sha) {
    throw new Error(
      'Remote source branch SHA differs from local HEAD. Push the intended commit explicitly, then request the MR again.',
    )
  }
  branchSchema.parse(
    await api(
      `${endpoint}/repository/branches/${encodeURIComponent(parameters.targetBranch)}`,
    ),
  )
  return project.id
}

async function publishOrReuse(
  pi: ExtensionAPI,
  api: GitLabAPI,
  parameters: MergeRequestParameters,
  projectId: number,
) {
  const mergeRequestSchema = pi.zod.object({
    id: pi.zod.number().int().positive(),
    iid: pi.zod.number().int().positive(),
    web_url: pi.zod.string(),
    source_project_id: pi.zod.number().int().positive(),
    target_project_id: pi.zod.number().int().positive(),
    source_branch: pi.zod.string(),
    target_branch: pi.zod.string(),
  })

  const endpoint = `projects/${projectId}`
  const query = new URLSearchParams({
    state: 'opened',
    scope: 'all',
    source_branch: parameters.sourceBranch,
    target_branch: parameters.targetBranch,
    per_page: '100',
  })
  const requests = pi.zod
    .array(mergeRequestSchema)
    .parse(
      await api(`${endpoint}/merge_requests?${query.toString()}`, 'GET', [
        '--paginate',
      ]),
    )
  const existing = requests.find(
    (request) =>
      request.source_project_id === projectId &&
      request.target_project_id === projectId &&
      request.source_branch === parameters.sourceBranch &&
      request.target_branch === parameters.targetBranch,
  )
  const request =
    existing ??
    mergeRequestSchema.parse(
      await api(`${endpoint}/merge_requests`, 'POST', [
        '--raw-field',
        `source_branch=${parameters.sourceBranch}`,
        '--raw-field',
        `target_branch=${parameters.targetBranch}`,
        '--raw-field',
        `title=${parameters.title}`,
        '--raw-field',
        `description=${parameters.description}`,
      ]),
    )
  return {
    url: request.web_url,
    projectId,
    id: request.id,
    iid: request.iid,
    sourceBranch: request.source_branch,
    targetBranch: request.target_branch,
    reused: existing !== undefined,
  }
}

async function createMergeRequest(
  pi: ExtensionAPI,
  parameters: MergeRequestParameters,
  signal: AbortSignal | undefined,
) {
  const run = commandRunner(pi, parameters.cwd, signal)
  const { sha, origin } = await readWorktree(run, parameters)
  const api: GitLabAPI = async (endpoint, method = 'GET', fields = []) => {
    const output = await run(
      'glab',
      [
        'api',
        '--hostname',
        origin.hostname,
        '--method',
        method,
        endpoint,
        ...fields,
      ],
      method === 'POST' ? 'Create merge request' : 'Read GitLab preflight',
    )
    try {
      const value: unknown = JSON.parse(output)
      return value
    } catch {
      throw new Error(
        'GitLab returned invalid JSON. Check GitLab availability; if creation was attempted, check for an existing MR before retrying.',
      )
    }
  }
  const projectId = await checkProjectBranches(
    pi,
    api,
    parameters,
    origin.repo,
    sha,
  )
  const result = await publishOrReuse(pi, api, parameters, projectId)
  return { ...result, sha }
}

export default function gitlabExtension(pi: ExtensionAPI): void {
  pi.setLabel('GitLab')
  pi.registerTool({
    name: 'gitlab_create_merge_request',
    label: 'Create GitLab merge request',
    description:
      'Create or reuse an open same-project GitLab branch merge request using an explicit canonical repo and owning worktree. Verifies origin project identity, current source branch, local/remote SHA, and target existence before any POST. No forks, automatic fetch/push, installation, or retries.',
    loadMode: 'discoverable',
    parameters: pi.zod.object({
      cwd: pi.zod.string().min(1).describe('Absolute owning Git worktree root'),
      repo: pi.zod
        .string()
        .min(1)
        .describe('Canonical GitLab namespace/project path, without hostname'),
      sourceBranch: pi.zod.string().min(1),
      targetBranch: pi.zod.string().min(1),
      title: pi.zod.string().min(1),
      description: pi.zod.string(),
    }),
    approval: () => ({
      tier: 'write',
      policy: 'prompt',
      reason: 'Publish an externally visible GitLab merge request',
    }),
    async execute(_toolCallId, parameters: MergeRequestParameters, signal) {
      try {
        const result = await createMergeRequest(pi, parameters, signal)
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          details: result,
        }
      } catch (error_) {
        throw error_ instanceof Error
          ? error_
          : new Error('GitLab merge request creation failed')
      }
    },
  })
}
