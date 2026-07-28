# OMP Extension Server

An in-process HTTP host for OMP `AgentSession` instances. The extension starts with the host OMP session, shares its normal credential storage and model catalog, and persists managed conversations through OMP's `SessionManager`.

## Security boundary

The API has no authentication or authorization. It grants access to models, the filesystem, and shell-capable OMP tools. The default listener is therefore `127.0.0.1:3000`. Do not set `OMP_SERVER_HOST` to a non-loopback address unless an authenticated trusted proxy provides the security boundary.

SSE events and message responses can contain prompts, paths, tool inputs, and tool outputs. API responses and request logs never include model credentials or request bodies.

## Setup and commands

The package is independent from the repository root and requires Bun 1.3.14 or newer.

```bash
cd server
bun install
bun dev       # launch OMP with this extension, under Bun watch mode
bun run check # format, lint, typecheck, and build
```

The root `omp.extensions` manifest registers `./server/src/index.ts` when this package is installed or linked as an OMP plugin. For repository development, `bun dev` passes the extension path explicitly. Managed sessions load normal OMP extensions for their working directory, except this server extension, which is filtered to prevent recursive listeners.

### Runtime dependencies

- `@oh-my-pi/pi-coding-agent` provides the supported SDK session, persistence, model, and extension-discovery APIs. It is MIT-licensed. Its filesystem, shell, and credential capabilities are the reason this unauthenticated server must remain loopback-only.
- `express` provides the HTTP listener and middleware stack. It is MIT-licensed. The app limits JSON bodies, disables `X-Powered-By`, exposes only explicit routes, and does not log bodies.
- `zod` validates every request body, parameter, and query before it reaches the SDK. It is MIT-licensed and reduces the untrusted-input surface.

Versions and transitive integrity hashes are pinned by `server/bun.lock`.

## Configuration

| Variable          | Default     | Meaning                        |
| ----------------- | ----------- | ------------------------------ |
| `OMP_SERVER_HOST` | `127.0.0.1` | HTTP bind address              |
| `OMP_SERVER_PORT` | `3000`      | HTTP port, from `1` to `65535` |

JSON request bodies are limited to 1 MiB. Message snapshots return at most 200 messages per request. SSE heartbeats are sent every 15 seconds.

## Response contracts

Successful JSON responses use a `data` envelope:

```json
{ "data": { "status": "ok" } }
```

Errors contain a stable code and safe message:

```json
{
  "error": {
    "code": "session_not_found",
    "message": "Managed session was not found"
  }
}
```

A managed session response includes `id`, the server lifecycle handle, and `sessionId`, the active persisted OMP conversation identity. Starting, switching, forking, or branching a conversation can change `sessionId` while `id` remains stable.

## Endpoints

### Service

| Method | Path                     | Description                                    |
| ------ | ------------------------ | ---------------------------------------------- |
| `GET`  | `/healthz`               | Listener status and live session count         |
| `GET`  | `/v1/models`             | Authenticated `provider/model` identifiers     |
| `GET`  | `/v1/history?cwd=<path>` | Persisted OMP sessions for a working directory |

### Session lifecycle

| Method   | Path                       | Description                                   |
| -------- | -------------------------- | --------------------------------------------- |
| `POST`   | `/v1/sessions`             | Create or resume a managed session            |
| `GET`    | `/v1/sessions`             | List live managed sessions                    |
| `GET`    | `/v1/sessions/:id`         | Read one session snapshot                     |
| `DELETE` | `/v1/sessions/:id`         | Abort, dispose, and remove a session          |
| `POST`   | `/v1/sessions/:id/new`     | Start a new conversation in the runtime       |
| `POST`   | `/v1/sessions/:id/switch`  | Switch to `{ "sessionFile": "..." }`          |
| `POST`   | `/v1/sessions/:id/fork`    | Fork the active conversation                  |
| `POST`   | `/v1/sessions/:id/branch`  | Branch from `{ "entryId": "..." }`            |
| `POST`   | `/v1/sessions/:id/compact` | Compact, optionally with `customInstructions` |

Create a new session with:

```json
{
  "mode": "new",
  "cwd": "/absolute/project/path",
  "label": "optional client label",
  "model": "provider/model-id",
  "thinkingLevel": "high"
}
```

Resume with `{"mode":"resume","sessionFile":"/path/to/session.jsonl"}`. `label`, `model`, and `thinkingLevel` are optional in both modes. Thinking levels are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, and `auto`.

### Prompt and state

| Method  | Path                          | Description                                  |
| ------- | ----------------------------- | -------------------------------------------- |
| `POST`  | `/v1/sessions/:id/prompts`    | Run `{ "prompt": "..." }` until completion   |
| `POST`  | `/v1/sessions/:id/steer`      | Deliver `{ "message": "..." }` while running |
| `POST`  | `/v1/sessions/:id/follow-ups` | Queue `{ "message": "..." }`                 |
| `POST`  | `/v1/sessions/:id/abort`      | Abort the active turn                        |
| `GET`   | `/v1/sessions/:id/messages`   | Paginate with `offset` and `limit`           |
| `GET`   | `/v1/sessions/:id/stats`      | Read OMP session statistics                  |
| `PATCH` | `/v1/sessions/:id/model`      | Set `{ "model": "provider/model-id" }`       |
| `PATCH` | `/v1/sessions/:id/thinking`   | Set `{ "thinkingLevel": "high" }`            |
| `PATCH` | `/v1/sessions/:id/name`       | Persist `{ "name": "..." }`                  |

A prompt can also include `"streamingBehavior":"steer"` or `"followUp"` when the session is already running. Client disconnect does not abort the prompt; use the abort endpoint explicitly.

Each paginated message item has `{ "entryId": "...", "message": { ... } }`. Use `entryId` as the branch endpoint's `entryId`; the `message` value is the typed OMP agent message.

## Server-Sent Events

Connect to `GET /v1/sessions/:id/events`. The server registers the subscriber before creating its initial snapshot, emits `snapshot` first, then drains events received during snapshot creation in order. Event names are:

- `snapshot`: current managed session metadata and status
- `omp`: a raw typed `AgentSessionEvent`
- `warning`: a safe model fallback or runtime warning
- `error`: a safe session-scoped asynchronous error
- `closed`: session deletion or server shutdown

There is no replay cursor. Reconnect for a new snapshot and use the messages endpoint to recover transcript state. Slow clients have bounded pending delivery and are disconnected when backpressure persists.

## Example

```bash
base=http://127.0.0.1:3000

curl -sS -X POST "$base/v1/sessions" \
  -H 'content-type: application/json' \
  -d '{"mode":"new","cwd":"/tmp","label":"demo"}'

id='<data.snapshot.id from the response>'
curl -N "$base/v1/sessions/$id/events"

curl -sS -X POST "$base/v1/sessions/$id/prompts" \
  -H 'content-type: application/json' \
  -d '{"prompt":"Describe this repository briefly."}'

curl -sS "$base/v1/sessions/$id/messages?offset=0&limit=100"
curl -sS -X DELETE "$base/v1/sessions/$id"
```
