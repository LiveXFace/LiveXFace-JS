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
  external_id: 'user_123',
  image: fs.readFileSync('./photo.jpg'),
  metadata: { name: 'John Doe', department: 'Engineering' },
})
console.log('Registered face:', face.id)

// Identify (1:N search)
const result = await client.faces.identify('collection-id', {
  image: fs.readFileSync('./query.jpg'),
  top_k: 3,
  threshold: 0.45,
})
for (const match of result.matches) {
  console.log(`${match.face.external_id}: ${(match.similarity * 100).toFixed(1)}%`)
}

// Verify (1:1 comparison)
const verify = await client.faces.verify('collection-id', {
  image: fs.readFileSync('./query.jpg'),
  face_id: face.id,
})
console.log('Match:', verify.match, 'Confidence:', verify.confidence)

// Liveness detection
const liveness = await client.faces.liveness('collection-id', {
  image: fs.readFileSync('./query.jpg'),
})
console.log('Live:', liveness.is_live, 'Spoof score:', liveness.spoof_score)
```

## Collections

```typescript
// List collections
const collections = await client.collections.list()

// Create a collection
const collection = await client.collections.create({
  name: 'employees',
  description: 'Employee face database',
})

// Delete a collection
await client.collections.delete(collection.id)
```

## Batch Operations

```typescript
// Batch register (up to 20 faces)
const batch = await client.faces.batchRegister('collection-id', [
  { external_id: 'user_1', image: fs.readFileSync('./user1.jpg') },
  { external_id: 'user_2', image: fs.readFileSync('./user2.jpg'), metadata: { role: 'admin' } },
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
  } else if (err instanceof LiveXFaceNetworkError) {
    console.error('Network error:', err.message)
  }
}
```

## Configuration

| Option    | Type     | Default                              | Description                     |
| --------- | -------- | ------------------------------------ | ------------------------------- |
| `apiKey`  | `string` | **required**                         | Your API key (`lxf_live_xxx`)    |
| `baseUrl` | `string` | `http://localhost:8080/api/v1`       | Base URL of the LiveXFace server|
| `timeout` | `number` | `30000`                              | Request timeout in milliseconds |
