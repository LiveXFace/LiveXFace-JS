// Idempotency keys, Retry-After and the opt-in retry policy, against a local
// HTTP server so dropped connections are real transport errors.
const { test, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { LiveXFace, LiveXFaceApiError, LiveXFaceNetworkError, generateIdempotencyKey } = require('../dist')

// Each test queues one handler per expected request; `requests` records what arrived.
let handlers = []
let requests = []
let baseUrl

const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers })
        const handle = handlers.shift()
        if (!handle) {
            res.writeHead(500).end('no handler queued')
            return
        }
        handle(req, res)
    })
})

const reply = (status, body, headers = {}) => (req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers })
    res.end(JSON.stringify(body))
}
const fail = (status, code, headers) =>
    reply(status, { success: false, requestId: 'req_1', error: { code, message: code.toLowerCase() } }, headers)
const drop = (req, res) => res.socket.destroy()

before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`
})
after(() => {
    server.closeAllConnections()
    server.close()
})
beforeEach(() => {
    handlers = []
    requests = []
})

const face = { id: 'f1', collectionId: 'col_1', externalId: 'u1', metadata: {}, createdAt: 'x' }
const img = () => Buffer.from([0xff, 0xd8, 0xff])
const enrol = (client, extra = {}) => client.faces.register('col_1', { externalId: 'u1', image: img(), ...extra })

// A client whose sleeps are recorded instead of waited.
function makeClient(config = {}) {
    const client = new LiveXFace({ apiKey: 'lxf_test_x', baseUrl, ...config })
    client.slept = []
    client._sleep = async (ms) => {
        client.slept.push(ms)
    }
    return client
}

test('429 with retries off exposes status, code, requestId and retryAfter', async () => {
    handlers = [fail(429, 'RATE_LIMIT_EXCEEDED', { 'Retry-After': '12' })]
    const client = makeClient()
    await assert.rejects(enrol(client), (err) => {
        assert.ok(err instanceof LiveXFaceApiError)
        assert.equal(err.statusCode, 429)
        assert.equal(err.code, 'RATE_LIMIT_EXCEEDED')
        assert.equal(err.requestId, 'req_1')
        assert.equal(err.retryAfter, 12)
        return true
    })
    assert.equal(requests.length, 1)
})

test('retryAfter is undefined without a parseable Retry-After', async () => {
    handlers = [fail(503, 'SERVICE_BUSY', { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' })]
    await assert.rejects(enrol(makeClient()), (err) => err.statusCode === 503 && err.retryAfter === undefined)
})

test('503 SERVICE_BUSY is retried after Retry-After with the same generated key', async () => {
    handlers = [fail(503, 'SERVICE_BUSY', { 'Retry-After': '5' }), reply(201, { success: true, data: face })]
    const client = makeClient({ maxRetries: 2 })
    const res = await enrol(client)
    assert.deepEqual(res, face)
    assert.equal(requests.length, 2)
    const key = requests[0].headers['idempotency-key']
    assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    assert.equal(requests[1].headers['idempotency-key'], key)
    assert.deepEqual(client.slept, [5000])
})

test('Retry-After is capped by maxRetryDelay', async () => {
    handlers = [fail(429, 'RATE_LIMIT_EXCEEDED', { 'Retry-After': '120' }), reply(201, { success: true, data: face })]
    const client = makeClient({ maxRetries: 1, maxRetryDelay: 2000 })
    await enrol(client)
    assert.deepEqual(client.slept, [2000])
})

test('a dropped enrolment is retried with the same key and returns the replay', async () => {
    handlers = [drop, reply(201, { success: true, data: face }, { 'Idempotent-Replayed': 'true' })]
    const client = makeClient({ maxRetries: 3 })
    const res = await enrol(client)
    assert.deepEqual(res, face)
    assert.equal(requests.length, 2)
    assert.ok(requests[0].headers['idempotency-key'])
    assert.equal(requests[1].headers['idempotency-key'], requests[0].headers['idempotency-key'])
    // No Retry-After on a network error: jittered backoff, 0..500 ms on the first retry.
    assert.equal(client.slept.length, 1)
    assert.ok(client.slept[0] >= 0 && client.slept[0] <= 500)
})

test('422 NO_FACE_DETECTED is never retried', async () => {
    handlers = [fail(422, 'NO_FACE_DETECTED')]
    const client = makeClient({ maxRetries: 3 })
    await assert.rejects(enrol(client), (err) => err instanceof LiveXFaceApiError && err.code === 'NO_FACE_DETECTED')
    assert.equal(requests.length, 1)
})

test('retries stop after maxRetries and surface the last error', async () => {
    handlers = [1, 2, 3].map(() => fail(503, 'SERVICE_BUSY'))
    const client = makeClient({ maxRetries: 2 })
    await assert.rejects(enrol(client), (err) => err.statusCode === 503)
    assert.equal(requests.length, 3)
    assert.equal(client.slept.length, 2)
    assert.ok(client.slept[1] <= 1000)
})

test('a caller key is sent on every attempt; no key and retries off sends none', async () => {
    handlers = [fail(500, 'INTERNAL_ERROR'), reply(201, { success: true, data: face })]
    await enrol(makeClient({ maxRetries: 1 }), { idempotencyKey: 'my-key-1' })
    assert.deepEqual(requests.map((r) => r.headers['idempotency-key']), ['my-key-1', 'my-key-1'])

    requests = []
    handlers = [reply(201, { success: true, data: face })]
    await enrol(makeClient())
    assert.equal('idempotency-key' in requests[0].headers, false)
})

test('batch methods send a caller key', async () => {
    const client = makeClient()
    handlers = [
        reply(200, { success: true, data: { succeeded: 1, failed: 0, results: [] } }),
        reply(202, { success: true, data: { id: 'job_1', status: 'queued' } }),
    ]
    const items = [{ externalId: 'u1', image: img() }]
    await client.faces.batchRegister('col_1', items, { idempotencyKey: 'batch-1' })
    await client.faces.batchRegisterAsync('col_1', items, { idempotencyKey: 'batch-2' })
    assert.deepEqual(requests.map((r) => r.headers['idempotency-key']), ['batch-1', 'batch-2'])
})

test('generateIdempotencyKey returns distinct UUID v4 strings', () => {
    const a = generateIdempotencyKey()
    const b = generateIdempotencyKey()
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    assert.match(a, v4)
    assert.match(b, v4)
    assert.notEqual(a, b)
})

test('a keyless POST is not retried on a network error or 500, but is on 503', async () => {
    const client = makeClient({ maxRetries: 3 })
    const identify = () => client.faces.identify('col_1', { image: img() })

    handlers = [drop]
    await assert.rejects(identify(), LiveXFaceNetworkError)
    assert.equal(requests.length, 1)

    requests = []
    handlers = [fail(500, 'INTERNAL_ERROR')]
    await assert.rejects(identify(), (err) => err.statusCode === 500)
    assert.equal(requests.length, 1)

    requests = []
    handlers = [fail(503, 'SERVICE_BUSY'), reply(200, { success: true, data: { matches: [] } })]
    await identify()
    assert.equal(requests.length, 2)
    assert.equal('idempotency-key' in requests[0].headers, false)
})

test('a GET is retried on a network error', async () => {
    handlers = [drop, reply(200, { success: true, data: face })]
    const res = await makeClient({ maxRetries: 1 }).faces.get('col_1', 'f1')
    assert.deepEqual(res, face)
    assert.equal(requests.length, 2)
})
