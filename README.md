<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/logo-white.svg">
    <img src="docs/brand/logo.svg" alt="LiveXFace" width="220">
  </picture>
</p>

# livexface

Official TypeScript/JavaScript SDK for [LiveXFace](https://github.com/imronreviady/livexface) — Face Recognition as a Service.

## Installation

```bash
npm install livexface
# or
yarn add livexface
```

Validated against API contract 2.0.0 (`/openapi.json` `info.version`), exported as `CONTRACT_VERSION`.
`npm test` calls every SDK method and checks its HTTP method, path and required fields against the pinned
`contract/openapi-2.0.0.json`; to move to a new contract, copy the release asset `openapi-<version>.json` into
`contract/`, then update the `CONTRACT_VERSION` file and the constant in `src/index.ts`.

## Quick Start

```typescript
import { LiveXFace } from 'livexface'
import * as fs from 'fs'

const client = new LiveXFace({
  apiKey: 'lxf_live_xxxxxxxxxxxx',
  baseUrl: 'https://your-instance/api/v1', // optional
})

// Register a face
const face = await client.faces.register('collection-id', {
  externalId: 'user_123',
  image: fs.readFileSync('./photo.jpg'),
  metadata: { name: 'John Doe', department: 'Engineering' },
})
console.log('Registered face:', face.id)

// Identify (1:N search)
const result = await client.faces.identify('collection-id', {
  image: fs.readFileSync('./query.jpg'),
  topK: 3,
})
for (const match of result.matches) {
  console.log(`${match.externalId}: ${(match.confidence * 100).toFixed(1)}%`)
}

// Verify (1:1 against a stored face)
const verify = await client.faces.verify('collection-id', {
  image: fs.readFileSync('./query.jpg'),
  faceId: face.id,
})
console.log('Match:', verify.match, 'Confidence:', verify.confidence, 'Threshold:', verify.thresholdUsed)

// Liveness detection
const liveness = await client.faces.liveness('collection-id', {
  image: fs.readFileSync('./query.jpg'),
})
console.log('Live:', liveness.isLive, 'Score:', liveness.livenessScore)
```

## Liveness Sessions and Enrolment

A collection can require liveness at enrolment. The enrolment token comes only
from a completed liveness session: the server picks the steps (one blink and
one or two head turns, in random order), the person performs them on camera,
and you submit the frames once, within 60 seconds. `turn_left` and
`turn_right` mean the person's own left and right.

```typescript
const prompts = { blink: 'Blink', turn_left: 'Turn your head to your left', turn_right: 'Turn your head to your right' }

// 1. Create a session and show its challenges, in order
const session = await client.faces.createLivenessSession('collection-id')
for (const step of session.challenges) showPrompt(prompts[step.type])

// 2. Capture 5 to 50 frames (JPEG or PNG) while the person performs them
const frames: Buffer[] = await captureFrames()

// 3. Complete it; mirrored: true when the frames are flipped like a selfie preview
const result = await client.faces.completeLivenessSession('collection-id', session.sessionId, frames, {
  mirrored: false,
})
console.log('Live:', result.isLive, result.steps.map((s) => `${s.type}: ${s.passed}`))

// 4. Enrol with the single-use token (valid 5 minutes, bound to this collection)
if (result.isLive && result.livenessToken) {
  const face = await client.faces.register('collection-id', {
    externalId: 'user_123',
    image: frames[0],
    livenessToken: result.livenessToken,
  })
}
```

A session is used up by any submission except one with fewer than 5 frames
(`IMAGE_REQUIRED`, 400), so a completion carries no idempotency key. With
`maxRetries` on, it is retried only on `429` (rejected before the session is
touched), never on network errors or `5xx`. Session errors:
`LIVENESS_SESSION_INVALID` (422, unknown, expired, already submitted, or
created for another collection) and `SERVICE_BUSY` (503, the engine was busy
after the session was used up; thrown at once, not retried). After either,
create a new session.

`activeLiveness(collectionId, frames)` still returns a verdict (`isLive`,
`overallScore`, `challenges`), but no token.

The batch methods accept `livenessToken` per item as well. Enrolment errors:
`LIVENESS_TOKEN_REQUIRED` (400, the collection needs a token),
`LIVENESS_TOKEN_INVALID` (422, unknown, expired or already used) and
`LIVENESS_FACE_MISMATCH` (422, the enrolled face is not the one that passed).

## Collections

Collections are created and managed in the LiveXFace dashboard, not through
the API, so the client has no methods for them. Create one there and pass its
ID to the calls above.

## Batch Operations

```typescript
// Batch register (up to 20 faces)
const batch = await client.faces.batchRegister('collection-id', [
  { externalId: 'user_1', image: fs.readFileSync('./user1.jpg') },
  { externalId: 'user_2', image: fs.readFileSync('./user2.jpg'), metadata: { role: 'admin' } },
])
console.log(`Succeeded: ${batch.succeeded}, Failed: ${batch.failed}`)

// Batch delete
const del = await client.faces.batchDelete('collection-id', ['face-id-1', 'face-id-2'])
```

## Error Handling

```typescript
import { LiveXFaceApiError, LiveXFaceNetworkError } from 'livexface'

try {
  const result = await client.faces.identify('col-id', { image: buffer })
} catch (err) {
  if (err instanceof LiveXFaceApiError) {
    console.error(`API error [${err.code}] ${err.statusCode}: ${err.message}`)
    console.error('Quote this when contacting support:', err.requestId)
  } else if (err instanceof LiveXFaceNetworkError) {
    console.error('Network error:', err.message)
  }
}
```

## Idempotent requests

`register`, `batchRegister` and `batchRegisterAsync` accept an idempotency key,
sent as the `Idempotency-Key` header. If the same key arrives again within 24
hours with the same request, the API does not enrol a second time: it replays
the first response (same status and body) with the header
`Idempotent-Replayed: true`. So when a connection drops and you cannot tell
whether the enrolment happened, send it again with the same key.

- Same key, different request: `422 IDEMPOTENCY_KEY_MISMATCH`.
- Same key while the first request is still running: `409 IDEMPOTENCY_KEY_IN_USE`.
- `429` and `5xx` responses are not remembered, so retrying with the same key
  runs the request again.
- Other `4xx` responses are remembered: after fixing the request (e.g. a new
  photo after `NO_FACE_DETECTED`), send it with a **new** key.

```typescript
import { generateIdempotencyKey } from 'livexface'

const key = generateIdempotencyKey() // a random UUID v4; store it with the job
await client.faces.register('collection-id', {
  externalId: 'user_123',
  image: fs.readFileSync('./photo.jpg'),
  idempotencyKey: key,
})

await client.faces.batchRegister('collection-id', items, { idempotencyKey: generateIdempotencyKey() })
```

## Production retries

Retries are off by default. `maxRetries` turns them on (attempts after the
first). `429` and `503` are retried after the `Retry-After` delay (capped by
`maxRetryDelay`), or after an exponential backoff with jitter. Network errors
and other `5xx` are retried only for GET, PATCH and DELETE and for requests
with an idempotency key; a plain POST such as `identify` is not. Other `4xx`
responses are never retried. `completeLivenessSession` is the exception to
the `503` rule: see [Liveness Sessions](#liveness-sessions-and-enrolment).
Enrolment and batch calls get a generated key when
you pass none, and every attempt of one call sends the same key.

```typescript
import { LiveXFace, LiveXFaceApiError, generateIdempotencyKey } from 'livexface'

const client = new LiveXFace({ apiKey: process.env.LIVEXFACE_API_KEY!, maxRetries: 3 })

try {
  const face = await client.faces.register('collection-id', {
    externalId: 'user_123',
    image: fs.readFileSync('./photo.jpg'),
    idempotencyKey: generateIdempotencyKey(),
  })
} catch (err) {
  if (err instanceof LiveXFaceApiError) {
    // After the last retry: e.g. 429 with retryAfter = 12 (seconds)
    console.error(err.statusCode, err.code, `retry after ${err.retryAfter}s`, err.requestId)
  }
}
```

## Configuration

| Option    | Type     | Default                              | Description                     |
| --------- | -------- | ------------------------------------ | ------------------------------- |
| `apiKey`  | `string` | **required**                         | Your API key (`lxf_live_xxx`)    |
| `baseUrl` | `string` | `http://localhost:8080/api/v1`       | Base URL of the LiveXFace server|
| `timeout` | `number` | `30000`                              | Request timeout in milliseconds |
| `maxRetries` | `number` | `0` (off)                        | Retries after the first attempt; see [Production retries](#production-retries) |
| `maxRetryDelay` | `number` | `60000`                        | Longest wait before one retry, in milliseconds |
