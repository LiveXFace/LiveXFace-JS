// Runs against the compiled client in dist/ (`npm test` builds first).
// fetch is stubbed per test, so no server is needed.
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const { LiveXFace, LiveXFaceApiError } = require('../dist')

const realFetch = globalThis.fetch
let calls = []

function stubFetch(status, body) {
    calls = []
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        return new Response(JSON.stringify(body), {
            status,
            headers: { 'Content-Type': 'application/json' },
        })
    }
}

afterEach(() => {
    globalThis.fetch = realFetch
})

const client = new LiveXFace({ apiKey: 'lxf_test_x', baseUrl: 'http://api.test/api/v1' })
const img = () => Buffer.from([0xff, 0xd8, 0xff])

const challenges = {
    blink: { passed: true, available: true, blinkCount: 1 },
    headTurn: { passed: null, available: false },
    passiveAntispoof: { passed: true, available: true, score: 0.97 },
}

test('activeLiveness sends frame_0..frame_n and parses the token', async () => {
    stubFetch(200, {
        success: true,
        data: {
            isLive: true,
            overallScore: 0.95,
            framesAnalyzed: 6,
            framesWithFace: 6,
            challenges,
            livenessToken: 'lvt_abc',
            livenessTokenExpiresAt: '2026-09-28T10:05:00Z',
        },
    })
    const frames = Array.from({ length: 6 }, img)
    const res = await client.faces.activeLiveness('col_1', frames)

    assert.equal(calls[0].url, 'http://api.test/api/v1/collections/col_1/active-liveness')
    assert.equal(calls[0].init.method, 'POST')
    const form = calls[0].init.body
    assert.deepEqual([...form.keys()], ['frame_0', 'frame_1', 'frame_2', 'frame_3', 'frame_4', 'frame_5'])
    assert.equal(res.isLive, true)
    assert.equal(res.livenessToken, 'lvt_abc')
    assert.equal(res.livenessTokenExpiresAt, '2026-09-28T10:05:00Z')
    assert.equal(res.challenges.blink.blinkCount, 1)
})

test('a failed activeLiveness check carries no token', async () => {
    stubFetch(200, {
        success: true,
        data: {
            isLive: false,
            overallScore: 0.2,
            framesAnalyzed: 5,
            framesWithFace: 5,
            challenges: { ...challenges, blink: { passed: false, available: true } },
        },
    })
    const res = await client.faces.activeLiveness('col_1', Array.from({ length: 5 }, img))
    assert.equal(res.isLive, false)
    assert.equal(res.challenges.blink.passed, false)
    assert.equal(res.livenessToken, undefined)
    assert.equal(res.livenessTokenExpiresAt, undefined)
})

test('activeLiveness surfaces IMAGE_REQUIRED', async () => {
    stubFetch(400, { success: false, error: { code: 'IMAGE_REQUIRED', message: 'at least 5 frames' } })
    await assert.rejects(client.faces.activeLiveness('col_1', [img()]), (err) => {
        assert.ok(err instanceof LiveXFaceApiError)
        assert.equal(err.code, 'IMAGE_REQUIRED')
        assert.equal(err.statusCode, 400)
        return true
    })
})

const face = { id: 'f1', collectionId: 'col_1', externalId: 'u1', metadata: {}, createdAt: 'x' }

test('register sends liveness_token when given', async () => {
    stubFetch(201, { success: true, data: face })
    await client.faces.register('col_1', { externalId: 'u1', image: img(), livenessToken: 'lvt_abc' })
    assert.equal(calls[0].url, 'http://api.test/api/v1/collections/col_1/faces')
    assert.equal(calls[0].init.body.get('liveness_token'), 'lvt_abc')
})

test('register omits liveness_token when not given', async () => {
    stubFetch(201, { success: true, data: face })
    await client.faces.register('col_1', { externalId: 'u1', image: img() })
    assert.equal(calls[0].init.body.has('liveness_token'), false)
})

for (const [method, path, data] of [
    ['batchRegister', 'faces/batch', { succeeded: 2, failed: 0, results: [] }],
    ['batchRegisterAsync', 'faces/batch-async', { id: 'job_1', status: 'queued' }],
]) {
    test(`${method} serializes livenessToken per entry`, async () => {
        stubFetch(200, { success: true, data })
        await client.faces[method]('col_1', [
            { externalId: 'u1', image: img(), livenessToken: 'lvt_1' },
            { externalId: 'u2', image: img() },
        ])
        assert.equal(calls[0].url, `http://api.test/api/v1/collections/col_1/${path}`)
        const entries = JSON.parse(calls[0].init.body.get('entries'))
        assert.deepEqual(entries, [
            { externalId: 'u1', metadata: {}, livenessToken: 'lvt_1' },
            { externalId: 'u2', metadata: {} },
        ])
    })
}
