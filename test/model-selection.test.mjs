/**
 * Model-selection checks for the relay half of this plugin (lib/index.js).
 *
 * The plugin registers one HTTP handler with the DSH web server; this drives
 * that handler directly with a stubbed Cordis context, so the whole route table
 * is exercised without a running DSH instance:
 *
 *   node test/model-selection.test.mjs
 *
 * It covers GET /dsh-relay/models, model selection through
 * POST /dsh-relay/delegate (inference, explicit provider, rejection paths and
 * ordering against the prompt), and the model hint on /dsh-relay/list and
 * /dsh-relay/poll.
 */
import assert from 'node:assert/strict'
import { apply, inject, name } from '../lib/index.js'

const CATALOG = {
  default: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
  routableProviders: ['deepseek', 'local'],
  groups: [
    {
      id: 'deepseek',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-v4.1-flash',
          name: 'Flash',
          description: 'fast',
          reasoning: {
            efforts: [
              { id: 'low', name: 'Low' },
              { id: 'high', name: 'High' },
            ],
            defaultEffort: 'low',
          },
        },
        { id: 'shared-id', name: 'Shared' },
      ],
    },
    { id: 'local', name: 'Local', models: [{ id: 'shared-id', name: 'Shared' }] },
  ],
  failures: [{ id: 'broken', name: 'Broken', message: 'no credentials' }],
}

function createHarness(options = {}) {
  const calls = []
  const sessions = [
    {
      sessionId: 'session-1',
      running: false,
      blank: false,
      cwd: 'D:\\ws',
      updatedAt: 1,
      projections: {
        kind: 'sequenced',
        asOfSeq: 3,
        values: {
          modelSelection: {
            lastUsed: { provider: 'deepseek', model: 'deepseek-v4.1-flash' },
            next: null,
          },
        },
      },
    },
  ]

  const controller = {
    list: async () => ({ items: sessions }),
    page: async () => ({ records: [] }),
    inspect: async () => ({ events: [] }),
    create: async (request) => {
      calls.push(['create', request])
      return { sessionId: 'session-new' }
    },
    selectModel: async (request) => {
      calls.push(['selectModel', request])
      if (options.selectModelFails) throw new Error('session/model-unavailable: unknown effort')
      const { sessionId, ...selected } = request
      return { selected }
    },
    modelCatalog: async () => {
      calls.push(['modelCatalog'])
      return CATALOG
    },
    prompt: async (request) => {
      calls.push(['prompt', request])
      return {}
    },
    cancel: async () => ({ accepted: true }),
  }

  let handler = null
  const ctx = {
    get(key) {
      if (key === 'webServer') {
        return {
          register(opts) {
            handler = opts.handler
            return () => {}
          },
        }
      }
      if (key === 'sessionController') return controller
      return undefined
    },
    on() {},
    effect(fn) {
      fn()
      return () => {}
    },
  }
  apply(ctx)
  assert.ok(handler, 'plugin registered its route handler')
  return { handler, calls }
}

async function request(handler, { method = 'GET', url, body, remote = '127.0.0.1' }) {
  let status = null
  let payload = null
  const res = {
    writeHead(code) {
      status = code
    },
    end(text) {
      payload = JSON.parse(text)
    },
  }
  const listeners = { data: [], end: [], error: [] }
  const req = {
    method,
    url,
    headers: {},
    socket: { remoteAddress: remote },
    on(event, cb) {
      ;(listeners[event] || (listeners[event] = [])).push(cb)
      return req
    },
  }
  const done = handler(req, res)
  if (body !== undefined) {
    for (const cb of listeners.data) cb(Buffer.from(JSON.stringify(body)))
  }
  for (const cb of listeners.end) cb()
  await done
  return { status, payload }
}

const cases = []
const test = (label, fn) => cases.push([label, fn])

test('exports the relay identity', () => {
  assert.equal(name, 'dsh-mcp-relay')
  assert.deepEqual(inject, ['webServer', 'sessionController'])
})

test('GET /models returns the trimmed catalog', async () => {
  const { handler } = createHarness()
  const { status, payload } = await request(handler, { url: '/dsh-relay/models' })
  assert.equal(status, 200)
  assert.equal(payload.ok, true)
  assert.deepEqual(payload.data.default, { provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  assert.deepEqual(payload.data.routableProviders, ['deepseek', 'local'])
  assert.equal(payload.data.providers.length, 2)
  assert.equal(payload.data.providers[0].models[0].reasoning.defaultEffort, 'low')
  assert.deepEqual(payload.data.providers[0].models[0].reasoning.efforts[1], {
    id: 'high',
    name: 'High',
    description: null,
  })
  assert.deepEqual(payload.data.providers[1].models[0], {
    id: 'shared-id',
    name: 'Shared',
    description: null,
    reasoning: null,
  })
  assert.deepEqual(payload.data.failures, [
    { id: 'broken', name: 'Broken', message: 'no credentials' },
  ])
})

test('delegate infers the provider and selects before prompting', async () => {
  const { handler, calls } = createHarness()
  const { payload } = await request(handler, {
    method: 'POST',
    url: '/dsh-relay/delegate',
    body: { instruction: 'do it', workspace: 'D:\\ws', model: 'deepseek-v4.1-flash' },
  })
  assert.equal(payload.ok, true, JSON.stringify(payload))
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['create', 'modelCatalog', 'selectModel', 'prompt'],
  )
  assert.deepEqual(calls[2][1], {
    sessionId: 'session-new',
    provider: 'deepseek',
    model: 'deepseek-v4.1-flash',
  })
  assert.deepEqual(payload.data.model, { provider: 'deepseek', model: 'deepseek-v4.1-flash' })
  assert.match(payload.data.modelNote, /saves it as the default/)
})

test('delegate accepts provider/model and a reasoning effort without a catalog read', async () => {
  const { handler, calls } = createHarness()
  const { payload } = await request(handler, {
    method: 'POST',
    url: '/dsh-relay/delegate',
    body: { instruction: 'do it', model: 'local/shared-id', reasoningEffort: 'high' },
  })
  assert.equal(payload.ok, true)
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['create', 'selectModel', 'prompt'],
  )
  assert.deepEqual(calls[1][1], {
    sessionId: 'session-new',
    provider: 'local',
    model: 'shared-id',
    reasoningEffort: 'high',
  })
})

test('delegate rejects an ambiguous bare model id without prompting', async () => {
  const { handler, calls } = createHarness()
  const { payload } = await request(handler, {
    method: 'POST',
    url: '/dsh-relay/delegate',
    body: { instruction: 'do it', model: 'shared-id' },
  })
  assert.equal(payload.ok, false)
  assert.match(payload.error, /offered by several providers \(deepseek, local\)/)
  assert.equal(calls.some((c) => c[0] === 'selectModel'), false)
  assert.equal(calls.some((c) => c[0] === 'prompt'), false)
})

test('delegate rejects an unknown model without prompting', async () => {
  const { handler, calls } = createHarness()
  const { payload } = await request(handler, {
    method: 'POST',
    url: '/dsh-relay/delegate',
    body: { instruction: 'do it', model: 'gpt-9' },
  })
  assert.equal(payload.ok, false)
  assert.match(payload.error, /not in this instance's catalog/)
  assert.equal(calls.some((c) => c[0] === 'prompt'), false)
})

test('delegate rejects a provider without a model', async () => {
  const { handler, calls } = createHarness()
  const { payload } = await request(handler, {
    method: 'POST',
    url: '/dsh-relay/delegate',
    body: { instruction: 'do it', provider: 'deepseek' },
  })
  assert.equal(payload.ok, false)
  assert.match(payload.error, /provider was given without model/)
  assert.equal(calls.some((c) => c[0] === 'selectModel'), false)
})

test('delegate without a model leaves selection alone', async () => {
  const { handler, calls } = createHarness()
  const { payload } = await request(handler, {
    method: 'POST',
    url: '/dsh-relay/delegate',
    body: { instruction: 'do it', workspace: 'D:\\ws' },
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.data.model, null)
  assert.equal(payload.data.modelNote, undefined)
  assert.equal(calls.some((c) => c[0] === 'selectModel'), false)
  assert.equal(calls.some((c) => c[0] === 'modelCatalog'), false)
  assert.equal(calls.filter((c) => c[0] === 'prompt').length, 1)
})

test('a rejected model selection fails the delegation before the prompt', async () => {
  const { handler, calls } = createHarness({ selectModelFails: true })
  const { payload } = await request(handler, {
    method: 'POST',
    url: '/dsh-relay/delegate',
    body: { instruction: 'do it', model: 'deepseek-v4.1-flash' },
  })
  assert.equal(payload.ok, false)
  assert.match(payload.error, /session\/model-unavailable/)
  assert.equal(calls.some((c) => c[0] === 'prompt'), false)
})

test('list and poll report the session model hint', async () => {
  const { handler } = createHarness()
  const listed = await request(handler, { url: '/dsh-relay/list' })
  assert.deepEqual(listed.payload.data.items[0].model, {
    provider: 'deepseek',
    model: 'deepseek-v4.1-flash',
  })

  const polled = await request(handler, { url: '/dsh-relay/poll?sessionId=session-1' })
  assert.equal(polled.payload.ok, true)
  assert.deepEqual(polled.payload.data.model, {
    provider: 'deepseek',
    model: 'deepseek-v4.1-flash',
  })
  assert.equal(polled.payload.data.status, 'idle')
})

test('a session without the model projection reports no model', async () => {
  const { handler } = createHarness()
  const { payload } = await request(handler, {
    method: 'POST',
    url: '/dsh-relay/delegate',
    body: { instruction: 'do it', workspace: 'D:\\ws' },
  })
  assert.equal(payload.ok, true)
  assert.equal(payload.data.model, null)
})

test('a non-loopback caller is refused', async () => {
  const { handler } = createHarness()
  const { status, payload } = await request(handler, {
    url: '/dsh-relay/models',
    remote: '10.0.0.7',
  })
  assert.equal(status, 403)
  assert.equal(payload.ok, false)
})

let failed = 0
for (const [label, fn] of cases) {
  try {
    await fn()
    console.log(`PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`FAIL  ${label}\n      ${error && error.message}`)
  }
}
console.log(failed === 0 ? `\nall ${cases.length} cases passed` : `\n${failed} case(s) failed`)
process.exitCode = failed === 0 ? 0 : 1
