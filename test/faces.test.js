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

const verdict = { overallScore: 0.95, framesAnalyzed: 6, framesWithFace: 6, challenges }

test('activeLiveness sends frame_0..frame_n and returns a verdict without a token', async () => {
    stubFetch(200, { success: true, data: { isLive: true, ...verdict } })
    const frames = Array.from({ length: 6 }, img)
    const res = await client.faces.activeLiveness('col_1', frames)

    assert.equal(calls[0].url, 'http://api.test/api/v1/collections/col_1/active-liveness')
    assert.equal(calls[0].init.method, 'POST')
    const form = calls[0].init.body
    assert.deepEqual([...form.keys()], ['frame_0', 'frame_1', 'frame_2', 'frame_3', 'frame_4', 'frame_5'])
    assert.equal(res.isLive, true)
    assert.equal(res.challenges.blink.blinkCount, 1)
    assert.equal('livenessToken' in res, false)
    assert.equal('livenessTokenExpiresAt' in res, false)
})

test('createLivenessSession posts no body and returns the ordered challenges', async () => {
    const session = {
        sessionId: 'lvs_abc',
        challenges: [{ type: 'turn_left' }, { type: 'blink' }, { type: 'turn_right' }],
        expiresAt: '2026-10-03T10:01:00Z',
    }
    stubFetch(201, { success: true, data: session })
    const res = await client.faces.createLivenessSession('col_1')

    assert.equal(calls[0].url, 'http://api.test/api/v1/collections/col_1/liveness-sessions')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal(calls[0].init.body, undefined)
    assert.equal('Idempotency-Key' in calls[0].init.headers, false)
    assert.deepEqual(res, session)
    assert.deepEqual(res.challenges.map((c) => c.type), ['turn_left', 'blink', 'turn_right'])
})

test('completeLivenessSession sends frames and mirrored, and parses steps and the token', async () => {
    stubFetch(200, {
        success: true,
        data: {
            isLive: true,
            ...verdict,
            steps: [{ type: 'turn_left', passed: true }, { type: 'blink', passed: true }],
            livenessToken: 'lvt_abc',
            livenessTokenExpiresAt: '2026-10-03T10:06:00Z',
        },
    })
    const res = await client.faces.completeLivenessSession('col_1', 'lvs_abc', Array.from({ length: 6 }, img), {
        mirrored: true,
    })

    assert.equal(calls[0].url, 'http://api.test/api/v1/collections/col_1/liveness-sessions/lvs_abc')
    assert.equal(calls[0].init.method, 'POST')
    assert.equal('Idempotency-Key' in calls[0].init.headers, false)
    const form = calls[0].init.body
    assert.deepEqual(
        [...form.keys()],
        ['frame_0', 'frame_1', 'frame_2', 'frame_3', 'frame_4', 'frame_5', 'mirrored'],
    )
    assert.equal(form.get('mirrored'), 'true')
    assert.equal(res.isLive, true)
    assert.deepEqual(res.steps, [{ type: 'turn_left', passed: true }, { type: 'blink', passed: true }])
    assert.equal(res.livenessToken, 'lvt_abc')
    assert.equal(res.livenessTokenExpiresAt, '2026-10-03T10:06:00Z')
})

test('completeLivenessSession sends mirrored=false by default; a failed session carries no token', async () => {
    stubFetch(200, {
        success: true,
        data: {
            isLive: false,
            ...verdict,
            overallScore: 0.2,
            steps: [{ type: 'blink', passed: true }, { type: 'turn_right', passed: false }],
        },
    })
    const res = await client.faces.completeLivenessSession('col_1', 'lvs_abc', Array.from({ length: 5 }, img))
    assert.equal(calls[0].init.body.get('mirrored'), 'false')
    assert.equal(res.isLive, false)
    assert.equal(res.steps[1].passed, false)
    assert.equal(res.livenessToken, undefined)
    assert.equal(res.livenessTokenExpiresAt, undefined)
})

test('completeLivenessSession surfaces LIVENESS_SESSION_INVALID as a typed error', async () => {
    stubFetch(422, {
        success: false,
        requestId: 'req_9',
        error: { code: 'LIVENESS_SESSION_INVALID', message: 'liveness session is invalid or expired' },
    })
    await assert.rejects(client.faces.completeLivenessSession('col_1', 'lvs_used', Array.from({ length: 5 }, img)), (err) => {
        assert.ok(err instanceof LiveXFaceApiError)
        assert.equal(err.code, 'LIVENESS_SESSION_INVALID')
        assert.equal(err.statusCode, 422)
        assert.equal(err.requestId, 'req_9')
        return true
    })
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

test('search parses skipped collections and surfaces typed profile mismatch', async () => {
    stubFetch(200, { success: true, data: { matches: [], queryTimeMs: 8, collectionsSearched: 1, skippedCollections: [{ id: 'c2', name: 'Legacy', reason: 'embedding_profile_mismatch' }] } })
    const result = await client.faces.search({ image: img(), collectionIds: ['c1', 'c2'], topK: 3 })
    assert.equal(calls[0].url, 'http://api.test/api/v1/search')
    assert.equal(calls[0].init.body.get('collection_ids'), 'c1,c2')
    assert.equal(result.skippedCollections[0].reason, 'embedding_profile_mismatch')

    stubFetch(409, { success: false, error: { code: 'EMBEDDING_PROFILE_MISMATCH', message: 'no compatible collections' } })
    await assert.rejects(client.faces.search({ image: img() }), (err) => err instanceof LiveXFaceApiError && err.statusCode === 409 && err.code === 'EMBEDDING_PROFILE_MISMATCH')
})

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

test("typed errors expose details", async () => {
  const restore = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: false,
        requestId: "r-1",
        error: { code: "MULTIPLE_FACES", message: "multiple faces detected", details: { faceCount: 2, faces: [] } },
      }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    );
  try {
    const client = new LiveXFace({ apiKey: "lxf_test", baseUrl: "http://x/api/v1" });
    await assert.rejects(
      client.faces.register("col", { externalId: "a", image: Buffer.from("img") }),
      (err) => err instanceof LiveXFaceApiError && err.code === "MULTIPLE_FACES" && err.details.faceCount === 2,
    );
  } finally {
    globalThis.fetch = restore;
  }
});
