# Changelog

All notable changes to this SDK are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
follows [Semantic Versioning](https://semver.org/).

## [1.0.0] - Unreleased

Validated against API contract 2.0.0.

### BREAKING

- `faces.activeLiveness` no longer returns a token: `livenessToken` and
  `livenessTokenExpiresAt` are removed from `ActiveLivenessResult`, because the
  API no longer issues them from the stateless check.

### Added

- `faces.createLivenessSession(collectionId)` returns a `LivenessSession`
  (`sessionId`, ordered `challenges`, `expiresAt`).
- `faces.completeLivenessSession(collectionId, sessionId, frames, { mirrored })`
  returns a `LivenessSessionResult`: the active-liveness fields, `steps`, and
  `livenessToken` / `livenessTokenExpiresAt` when the session passed.
- A completion is retried only on 429, never on a network error or 5xx: a 503
  `SERVICE_BUSY` comes after the session was used up, so it is thrown at once
  and the caller creates a new session.
- `LIVENESS_SESSION_INVALID` (422) surfaces as a `LiveXFaceApiError`.
- Exported types `LivenessChallengeType`, `LivenessChallenge`,
  `LivenessSession`, `LivenessStep`, `CompleteLivenessSessionOptions` and
  `LivenessSessionResult`.

### Migration

`activeLiveness` no longer returns a token; create a session, show its
challenges, complete it with the frames:

```typescript
// Before (0.x)
const check = await client.faces.activeLiveness(col, frames)
await client.faces.register(col, { externalId, image, livenessToken: check.livenessToken })

// After (1.0)
const session = await client.faces.createLivenessSession(col)
// show session.challenges to the person, in order, and capture frames
const result = await client.faces.completeLivenessSession(col, session.sessionId, frames, { mirrored: false })
if (result.livenessToken) {
  await client.faces.register(col, { externalId, image, livenessToken: result.livenessToken })
}
```

## [0.1.0]

- Initial release, validated against API contract 1.0.0.
