import { z } from 'zod'

import { ApiError } from './errors.js'

const DEFAULT_PORT = 3000

const environmentSchema = z.object({
  OMP_SERVER_HOST: z.string().trim().min(1).default('127.0.0.1'),
  OMP_SERVER_PORT: z.coerce
    .number()
    .int()
    .min(1)
    .max(65_535)
    .default(DEFAULT_PORT),
})

export interface ServerConfig {
  readonly host: string
  readonly port: number
  readonly jsonBodyLimit: string
  readonly sseHeartbeatMilliseconds: number
}

export function loadServerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ServerConfig {
  const result = environmentSchema.safeParse(environment)
  if (!result.success) {
    throw new ApiError(
      500,
      'invalid_server_configuration',
      'OMP server host or port configuration is invalid',
      result.error,
    )
  }

  return {
    host: result.data.OMP_SERVER_HOST,
    port: result.data.OMP_SERVER_PORT,
    jsonBodyLimit: '1mb',
    sseHeartbeatMilliseconds: 15_000,
  }
}
