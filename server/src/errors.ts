import type { ErrorRequestHandler } from 'express'

import type { ServerLogger } from './types.js'

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(status: number, code: string, message: string, cause?: Error) {
    if (cause === undefined) {
      super(message)
    } else {
      super(message, { cause })
    }
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export function normalizeError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error('A non-Error value was thrown')
}

export function operationError(
  code: string,
  message: string,
  value: unknown,
): ApiError {
  return new ApiError(500, code, message, normalizeError(value))
}

function toApiError(error: Error): ApiError {
  if (error instanceof ApiError) return error
  if ('status' in error && error.status === 400) {
    return new ApiError(
      400,
      'invalid_request',
      'Request body is not valid JSON',
      error,
    )
  }
  if ('status' in error && error.status === 413) {
    return new ApiError(
      413,
      'request_too_large',
      'Request body exceeds the 1 MiB limit',
      error,
    )
  }
  return new ApiError(
    500,
    'internal_error',
    'The server could not complete the request',
    error,
  )
}

export function createErrorHandler(logger: ServerLogger): ErrorRequestHandler {
  return (value: unknown, request, response, _next): void => {
    const normalized = normalizeError(value)
    const error = toApiError(normalized)
    const diagnostic = error.cause instanceof Error ? error.cause : error

    logger.error('HTTP request failed', {
      method: request.method,
      path: request.path,
      code: error.code,
      error: diagnostic.message,
      stack: diagnostic.stack,
    })
    response.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
      },
    })
  }
}
