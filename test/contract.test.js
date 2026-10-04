// Checks every SDK method against the pinned API contract: the HTTP method and
// path must exist in contract/openapi-<CONTRACT_VERSION>.json and every field the
// contract marks required must be sent. fetch is stubbed, so no server is needed.
const { test, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { LiveXFace, CONTRACT_VERSION } = require('../dist')

const root = path.join(__dirname, '..')
const pinned = fs.readFileSync(path.join(root, 'CONTRACT_VERSION'), 'utf8').trim()
const contract = JSON.parse(fs.readFileSync(path.join(root, 'contract', `openapi-${pinned}.json`), 'utf8'))
const prefix = contract.servers[0].url // "/api/v1"; contract paths are relative to it

const realFetch = globalThis.fetch
afterEach(() => {
    globalThis.fetch = realFetch
})

const client = new LiveXFace({ apiKey: 'lxf_test_x', baseUrl: `http://api.test${prefix}` })
const img = () => Buffer.from([0xff, 0xd8, 0xff])
const col = 'col_1'
const items = [
    { externalId: 'u1', image: img(), metadata: { team: 'a' }, livenessToken: 'lvt_1' },
    { externalId: 'u2', image: img() },
]

// One call per public method, keyed by the client property holding the
// resource. Optional arguments are passed so every field the SDK can send is sent.
const cases = {
    faces: {
        register: (f) =>
            f.register(col, { externalId: 'u1', image: img(), metadata: { team: 'a' }, livenessToken: 'lvt_1', idempotencyKey: 'k1' }),
        list: (f) => f.list(col, { limit: 10, offset: 5 }),
        get: (f) => f.get(col, 'face_1'),
        getByExternalId: (f) => f.getByExternalId(col, 'u1'),
        delete: (f) => f.delete(col, 'face_1'),
        verify: (f) => f.verify(col, { image: img(), faceId: 'face_1', threshold: 0.5 }),
        identify: (f) => f.identify(col, { image: img(), topK: 3, threshold: 0.5 }),
        liveness: (f) => f.liveness(col, { image: img() }),
        activeLiveness: (f) => f.activeLiveness(col, Array.from({ length: 5 }, img)),
        createLivenessSession: (f) => f.createLivenessSession(col),
        completeLivenessSession: (f) =>
            f.completeLivenessSession(col, 'lvs_1', Array.from({ length: 5 }, img), { mirrored: true }),
        compare: (f) => f.compare({ image1: img(), image2: img(), threshold: 0.5 }),
        batchRegister: (f) => f.batchRegister(col, items, { idempotencyKey: 'k2' }),
        batchDelete: (f) => f.batchDelete(col, ['face_1', 'face_2']),
        attributes: (f) => f.attributes(col, { image: img(), filename: 'a.png' }),
        batchRegisterAsync: (f) => f.batchRegisterAsync(col, items, { idempotencyKey: 'k3' }),
        getBatchJob: (f) => f.getBatchJob(col, 'job_1'),
    },
}

// The client itself plus every resource object it exposes (client.faces, ...).
const surfaces = {
    client,
    ...Object.fromEntries(
        Object.entries(client).filter(
            ([k, v]) => !k.startsWith('_') && v && typeof v === 'object' && Object.getPrototypeOf(v) !== Object.prototype,
        ),
    ),
}
const publicMethods = (obj) =>
    Object.getOwnPropertyNames(Object.getPrototypeOf(obj)).filter(
        (n) => n !== 'constructor' && !n.startsWith('_') && typeof obj[n] === 'function',
    )

// `images[0]` stands for any `images[N]`, `frame_0` for any `frame_N`.
const slot = (name) => name.replace(/\[\d+\]$/, '[]').replace(/_\d+$/, '_')
const paramCount = (template) => (template.match(/\{/g) ?? []).length

/** The contract path template for `p`; a literal segment beats a parameter, as in the router. */
function findTemplate(p) {
    const segs = p.split('/')
    return Object.keys(contract.paths)
        .filter((t) => {
            const ts = t.split('/')
            return ts.length === segs.length && ts.every((s, i) => s.startsWith('{') || s === segs[i])
        })
        .sort((a, b) => paramCount(a) - paramCount(b))[0]
}

function requiredFields(op, contentType) {
    const params = (op.parameters ?? [])
        .filter((p) => p.required && p.in !== 'path') // path params are satisfied by the match
        .map((p) => `${p.in}:${p.in === 'header' ? p.name.toLowerCase() : p.name}`)
    let schema = op.requestBody?.content?.[contentType]?.schema ?? {}
    if (schema.$ref) schema = contract.components.schemas[schema.$ref.split('/').pop()]
    return [...params, ...(schema.required ?? []).map((n) => `body:${slot(n)}`)]
}

/** Calls `run` with fetch stubbed and returns the one request it made. */
async function capture(run) {
    const calls = []
    globalThis.fetch = async (url, init) => {
        calls.push({ url, init })
        // A one-face array satisfies getByExternalId; every other method returns data as-is.
        return new Response(JSON.stringify({ success: true, data: [{ id: 'face_1' }] }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        })
    }
    await run()
    assert.equal(calls.length, 1, 'expected exactly one request')
    return calls[0]
}

test(`CONTRACT_VERSION matches the CONTRACT_VERSION file and the pinned contract (${pinned})`, () => {
    assert.equal(CONTRACT_VERSION, pinned)
    assert.equal(contract.info.version, pinned)
})

test('every public SDK method is exercised by the contract check', () => {
    for (const [name, obj] of Object.entries(surfaces)) {
        const missing = publicMethods(obj).filter((m) => !(cases[name] && m in cases[name]))
        assert.deepEqual(missing, [], `${name} has public methods the contract check does not call; add them to cases`)
    }
})

for (const [resource, methods] of Object.entries(cases)) {
    for (const [method, run] of Object.entries(methods)) {
        const name = `${resource}.${method}`
        test(`${name} matches contract ${pinned}`, async () => {
            const { url, init } = await capture(() => run(surfaces[resource]))
            const u = new URL(url)
            assert.ok(u.pathname.startsWith(prefix), `${name}: ${u.pathname} is outside ${prefix}`)
            const p = u.pathname.slice(prefix.length)
            const verb = init.method.toUpperCase()

            const template = findTemplate(p)
            assert.ok(template, `${name}: ${verb} ${p} matches no path in contract ${pinned}`)
            const op = contract.paths[template][verb.toLowerCase()]
            assert.ok(op, `${name}: contract ${pinned} has no ${verb} on ${template}`)

            const sent = new Set([...u.searchParams.keys()].map((k) => `query:${k}`))
            for (const h of Object.keys(init.headers ?? {})) sent.add(`header:${h.toLowerCase()}`)
            let contentType
            if (init.body instanceof FormData) {
                contentType = 'multipart/form-data'
                for (const k of init.body.keys()) sent.add(`body:${slot(k)}`)
            } else if (typeof init.body === 'string') {
                contentType = 'application/json'
                for (const k of Object.keys(JSON.parse(init.body))) sent.add(`body:${k}`)
            }
            if (contentType) {
                assert.ok(op.requestBody?.content?.[contentType], `${name}: ${verb} ${template} does not accept ${contentType}`)
            } else {
                assert.ok(!op.requestBody?.required, `${name}: ${verb} ${template} requires a body; none sent`)
            }

            const missing = requiredFields(op, contentType).filter((f) => !sent.has(f))
            assert.deepEqual(missing, [], `${name}: ${verb} ${template} is missing required fields`)
        })
    }
}
