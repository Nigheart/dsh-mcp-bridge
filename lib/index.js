/**
 * dsh-mcp-bridge — a host Cordis plugin for DeepSeek Harness.
 *
 * Mounts an HTTP control surface inside the *running* DSH instance so an
 * external controller (Codex over MCP) can drive the same sessions the Web GUI
 * is attached to:
 *
 *   GET  /dsh-bridge/ping
 *   GET  /dsh-bridge/list?cwd=<workspace>
 *   POST /dsh-bridge/delegate   { instruction, workspace?, sessionId?, mode?, agentPreset?, takeover? }
 *   GET  /dsh-bridge/poll?sessionId=<id>&max=<n>
 *   POST /dsh-bridge/cancel     { sessionId }
 *   GET  /dsh-bridge/questions
 *   POST /dsh-bridge/answer     { sessionId, answers: [{ id, selected, custom? }] }
 *   POST /dsh-bridge/takeover   { sessionId, enabled }
 *
 * Every response is `{ ok: true, data }` or `{ ok: false, error }`.
 *
 * Three design points worth knowing before editing:
 *
 * 1. Reading a session uses a cheap cursor plus one page, never a full
 *    `inspect`. `sessionController.list()` already has to be called for the
 *    running flag, and its `projections.asOfSeq` IS the log cursor, so
 *    `page({ throughSeq: cursor, maxMessages })` returns just the tail. A full
 *    `inspect` is O(whole log) and made every poll slower as sessions grew.
 *
 * 2. "Waiting on a human" is detected from the log, not from events. A
 *    `tool/call` with no matching `tool/result` while the agent is running is
 *    the reliable signature; it covers a pending approval and an
 *    `ask_user_question` alike, and still carries the tool name.
 *
 * 3. Answering DSH's questions is done by INTERCEPTING the tool call, not by
 *    joining the answerer waterfall. Listening to `approval/request` or
 *    `user-questions/request` does not work from this bundle: the Web GUI's
 *    answerer (@deepseek-ai/dsh-api-remotes) registers upstream and, when a
 *    browser is attached, forwards and terminates the chain without calling
 *    `next()`. `tools/pre-execute` is reachable, so a session under takeover has
 *    its `ask_user_question` call suspended until an outside answer arrives, and
 *    the answer is then fed back as a `deny` reason. On timeout the call is
 *    delegated downstream, so the GUI still works when nobody answers.
 *
 * This is an unauthenticated control surface when reachable, and the shipped
 * Web profile binds `0.0.0.0`. It is therefore fenced to loopback callers by
 * default; set DSH_BRIDGE_TOKEN to additionally require an
 * `x-dsh-bridge-token` header from loopback callers.
 */

export const name = 'dsh-mcp-bridge'

// Declare both services as hard dependencies so Cordis activates this row only
// after they exist. Without this the plugin can apply first, read
// ctx.get('webServer') as undefined, and decline to mount — silently, because
// that guard is written to tolerate a deployment without a web server, not to
// report a startup race. The bundle patch repeats the same list at row level.
export const inject = ['webServer', 'sessionController']

const ROUTE_PREFIX = '/dsh-bridge'
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const DEFAULT_PAGE_MESSAGES = 50
const TAKEOVER_TIMEOUT_MS = 180000

function isLoopback(req) {
  const socket = req && req.socket
  const address = socket && socket.remoteAddress
  return typeof address === 'string' && LOOPBACK_ADDRESSES.has(address)
}

function isAuthorized(req, token) {
  if (!token) return true
  const headers = req && req.headers
  return Boolean(headers) && headers['x-dsh-bridge-token'] === token
}

export function apply(ctx) {
  const web = ctx.get('webServer')
  const controller = ctx.get('sessionController')
  const timer = ctx.get('timer')
  if (web === undefined || controller === undefined) {
    // Fail loud instead of silently declining to mount. A quiet return here is
    // exactly how this plugin's startup race stayed invisible: the fiber was
    // healthy, the row looked loaded, and the route simply never existed.
    throw new Error(
      '[dsh-mcp-bridge] required services missing ' +
        `(webServer=${web !== undefined}, sessionController=${controller !== undefined}); ` +
        'the bundle row must declare inject: [webServer, sessionController]',
    )
  }

  const token = process.env.DSH_BRIDGE_TOKEN || ''
  let counter = 0
  const nextRequestId = () => `bridge-${Date.now()}-${++counter}`
  const newSignal = () => new AbortController().signal

  const reply = (res, status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  }

  const readRequestBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (chunk) => {
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', () => resolve(''))
    })

  const parseQuery = (url) => {
    const out = {}
    const index = url.indexOf('?')
    const qs = index >= 0 ? url.slice(index + 1) : ''
    for (const pair of qs.split('&')) {
      if (!pair) continue
      const eq = pair.indexOf('=')
      const key = eq < 0 ? pair : pair.slice(0, eq)
      const value = eq < 0 ? '' : pair.slice(eq + 1)
      try {
        out[decodeURIComponent(key)] = decodeURIComponent(value)
      } catch {
        out[key] = value
      }
    }
    return out
  }

  const safe = async (fn) => {
    try {
      return { ok: true, data: await fn() }
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) }
    }
  }

  // Read only plain scalars out of the persisted log; never JSON.stringify a
  // live Session/Agent object.
  const textOfBlocks = (content) => {
    if (!Array.isArray(content)) return ''
    const parts = []
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
  }

  const listAll = async () => {
    const value = await controller.list({}, newSignal())
    return (value && value.items) || []
  }

  const summaryOf = (items, sessionId) => {
    for (const session of items) {
      if (String(session.sessionId) === sessionId) return session
    }
    return null
  }

  const cursorOf = (summary) => {
    const asOf = summary && summary.projections && summary.projections.asOfSeq
    return typeof asOf === 'number' ? asOf : null
  }

  const summarizeSessions = (items, filterCwd) => {
    const rows = []
    for (const session of items) {
      const cwd = session.cwd === undefined ? null : String(session.cwd)
      if (filterCwd && cwd !== filterCwd) continue
      const id = String(session.sessionId)
      rows.push({
        sessionId: id,
        running: session.running === true,
        blank: session.blank === true,
        origin: session.origin === undefined ? null : String(session.origin),
        parentSessionId:
          session.parentSessionId === undefined ? null : String(session.parentSessionId),
        cwd,
        updatedAt: typeof session.updatedAt === 'number' ? session.updatedAt : null,
        takeover: takeoverSessions.has(id),
      })
    }
    return rows
  }

  // ── workspace grouping ────────────────────────────────────────────────────
  // DSH groups a session in the GUI by an explicit workspace attachment, not by
  // its cwd: a session created with { cwd } runs perfectly well, but the GUI
  // lists it as "ungrouped". Attach it to the workspace that owns its directory.
  //
  // Grouping is cosmetic, so nothing here may fail a delegation: every failure
  // is reported in the result rather than thrown. The registry is read at call
  // time instead of being declared in `inject`, so a deployment that lacks it
  // still mounts this plugin and simply reports grouping: null.
  const attachToWorkspace = async (sessionId, workspaceHint) => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) return { attached: false, reason: 'workspaceRegistry unavailable' }

    let path = typeof workspaceHint === 'string' && workspaceHint ? workspaceHint : null
    if (path === null) {
      try {
        const summary = summaryOf(await listAll(), sessionId)
        path = summary && typeof summary.cwd === 'string' && summary.cwd ? summary.cwd : null
      } catch {
        path = null
      }
    }
    if (path === null) return { attached: false, reason: 'session has no cwd to group by' }

    try {
      let entity = await registry.resolveByPath(path)
      const registered = entity === undefined
      if (registered) entity = await registry.create(path)
      await entity.attachSession(sessionId)
      return {
        attached: true,
        registered,
        workspaceId: String(entity.id),
        path: String(entity.path),
      }
    } catch (error) {
      return { attached: false, reason: String(error && error.message ? error.message : error) }
    }
  }

  // Attach every session whose cwd already has a registered workspace but which
  // no workspace claims. Idempotent: already-attached sessions are left alone.
  const attachAllOrphans = async () => {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined) throw new Error('workspaceRegistry is unavailable')

    const workspaces = registry.list()
    const owned = new Set()
    const byPath = new Map()
    for (const workspace of workspaces) {
      byPath.set(String(workspace.path).toLowerCase(), workspace)
      const ids = workspace.sessionIds
      if (Array.isArray(ids)) for (const id of ids) owned.add(String(id))
    }

    const items = await listAll()
    const attached = []
    const skipped = []
    const errors = []
    for (const session of items) {
      const sessionId = String(session.sessionId)
      if (owned.has(sessionId)) continue
      const cwd = session.cwd === undefined || session.cwd === null ? null : String(session.cwd)
      if (cwd === null) {
        skipped.push({ sessionId, reason: 'no cwd' })
        continue
      }
      const entity = byPath.get(cwd.toLowerCase())
      if (entity === undefined) {
        skipped.push({ sessionId, cwd, reason: 'directory is not a registered workspace' })
        continue
      }
      try {
        await entity.attachSession(sessionId)
        attached.push({ sessionId, cwd })
      } catch (error) {
        errors.push({ sessionId, reason: String(error && error.message ? error.message : error) })
      }
    }
    return { attached, skipped, errors, totalSessions: items.length, workspaces: workspaces.length }
  }

  // ── takeover: answer the agent's questions from the outside ───────────────

  const takeoverSessions = new Set()
  const awaiting = new Map()
  const interceptionLog = []

  // Approval handling. Sessions listed here get the approval waterfall answered
  // here with a one-shot grant; every other session delegates downstream to the
  // GUI's answerer. The default must stay "delegate": this listener can sit
  // upstream of the browser, and answering unconditionally would take approval
  // away from the person using the GUI.
  const autoApproveSessions = new Set()
  const approvalDiagnostics = { listenerHits: 0, granted: 0, lastSeenAt: null }
  const note = (entry) => {
    interceptionLog.push(entry)
    if (interceptionLog.length > 30) interceptionLog.shift()
  }

  const questionsOf = (args) => {
    const list = args && Array.isArray(args.questions) ? args.questions : []
    return list.slice(0, 5).map((question) => ({
      id: question && question.id !== undefined ? String(question.id) : null,
      header: question && typeof question.header === 'string' ? question.header : null,
      question: question && typeof question.question === 'string' ? question.question : null,
      options: Array.isArray(question && question.options)
        ? question.options.map((option) => (option && option.label ? String(option.label) : null))
        : null,
      multiSelect: question && question.multiSelect === true,
    }))
  }

  const formatAnswer = (answers) => {
    const lines = ['[外部控制器已代答，请直接采用以下回答继续工作，不要再次询问]']
    for (const answer of answers) {
      const selected = Array.isArray(answer.selected) ? answer.selected.join(', ') : ''
      lines.push(`- ${answer.id}: ${selected}${answer.custom ? ` (${answer.custom})` : ''}`)
    }
    return lines.join('\n')
  }

  // ask_user_question is a tool call like any other, so tools/pre-execute can
  // intercept it — the only interception point reachable from a plugin that
  // loads after the GUI's answerer owns the waterfall.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const name = exec && exec.name
    if (name !== 'ask_user_question') return next()
    const agent = exec && exec.agent
    const sessionId = agent && agent.id !== undefined && agent.id !== null ? String(agent.id) : null
    if (!sessionId || !takeoverSessions.has(sessionId)) return next()

    const questions = questionsOf(exec.arguments)
    note({ kind: 'intercepted', sessionId, questions, at: Date.now() })

    const answer = await new Promise((resolve) => {
      let dispose = null
      const finish = (value) => {
        if (dispose) {
          try {
            dispose()
          } catch {
            /* the timer may already have fired */
          }
        }
        awaiting.delete(sessionId)
        resolve(value)
      }
      awaiting.set(sessionId, { questions, at: Date.now(), resolve: finish })
      if (timer !== undefined) {
        try {
          dispose = timer.timeout(() => finish(null), TAKEOVER_TIMEOUT_MS)
        } catch {
          dispose = null
        }
      }
    })

    if (!answer) {
      note({ kind: 'takeover-timeout', sessionId, at: Date.now() })
      return next()
    }
    note({ kind: 'answered', sessionId, answers: answer, at: Date.now() })
    return { kind: 'deny', reason: formatAnswer(answer) }
  })

  // ── status read: cheap cursor + one page ─────────────────────────────────

  ctx.on('approval/request', (req, next) => {
    approvalDiagnostics.listenerHits += 1
    approvalDiagnostics.lastSeenAt = Date.now()
    let sessionId = null
    try {
      const agent = req && req.agent
      if (agent && agent.id !== undefined && agent.id !== null) sessionId = String(agent.id)
    } catch {
      sessionId = null
    }
    if (sessionId !== null && autoApproveSessions.has(sessionId)) {
      approvalDiagnostics.granted += 1
      note({ kind: 'approval-granted', sessionId, toolName: req && req.toolName, at: Date.now() })
      return Promise.resolve('allowed-once')
    }
    return next()
  })

  const readSession = async (sessionId, summary, maxMessages) => {
    const cursor = cursorOf(summary)
    let records = []
    let source = 'page'

    if (cursor === null) {
      source = 'inspect-fallback'
      const inspection = await controller.inspect(sessionId, newSignal())
      const events = Array.isArray(inspection.events) ? inspection.events : []
      records = events.map((event) => ({ type: 'event', event }))
    } else {
      const page = await controller.page(
        { address: { kind: 'session', sessionId }, throughSeq: cursor, maxMessages },
        newSignal(),
      )
      records = Array.isArray(page.records) ? page.records : []
    }

    let lastSeq = 0
    let lastEventType = null
    let lastEventTime = null
    let lastAssistant = null
    let assistantCount = 0
    const pendingCalls = new Map()
    const callOrder = []
    const approvals = new Map()

    for (const record of records) {
      const event = record && record.event ? record.event : record
      if (!event || typeof event.type !== 'string') continue
      if (typeof event.seq === 'number' && event.seq > lastSeq) lastSeq = event.seq
      lastEventType = event.type
      if (typeof event.time === 'number') lastEventTime = event.time

      const data = event.data
      if (event.type === 'assistant/message') {
        assistantCount += 1
        const text = textOfBlocks(data && data.message && data.message.content)
        if (text) lastAssistant = { seq: typeof event.seq === 'number' ? event.seq : null, text }
      } else if (event.type === 'tool/call') {
        const callId = data && data.callId !== undefined && data.callId !== null ? String(data.callId) : null
        if (callId) {
          pendingCalls.set(callId, {
            name: data && typeof data.name === 'string' ? data.name : null,
            seq: typeof event.seq === 'number' ? event.seq : null,
          })
          callOrder.push(callId)
        }
      } else if (event.type === 'tool/result') {
        const messageSource = data && data.message && data.message.source
        const callId =
          messageSource && messageSource.callId !== undefined && messageSource.callId !== null
            ? String(messageSource.callId)
            : null
        if (callId) pendingCalls.delete(callId)
      } else if (event.type === 'approval/asked') {
        // Approvals are an audit pair: `approval/asked` opens an id and
        // `approval/decided` closes it. An id still open is a decision the agent
        // is blocked on — the truthful "waiting on a human" signal, which a bare
        // tool/call is not.
        const id = data && data.id !== undefined && data.id !== null ? String(data.id) : null
        if (id) {
          approvals.set(id, {
            toolName: data && typeof data.toolName === 'string' ? data.toolName : null,
            callId:
              data && data.callId !== undefined && data.callId !== null ? String(data.callId) : null,
            reason: data && typeof data.reason === 'string' ? data.reason : null,
            seq: typeof event.seq === 'number' ? event.seq : null,
          })
        }
      } else if (event.type === 'approval/decided') {
        const id = data && data.id !== undefined && data.id !== null ? String(data.id) : null
        if (id) approvals.delete(id)
      }
    }

    return {
      source,
      cursor,
      pageRecords: records.length,
      lastSeq,
      lastEventType,
      lastEventTime,
      assistantCount,
      lastAssistant,
      pendingCalls,
      callOrder,
      approvals,
    }
  }

  const buildStatus = async (sessionId, maxMessages) => {
    const items = await listAll()
    const summary = summaryOf(items, sessionId)
    const running = summary ? summary.running === true : null
    const view = await readSession(sessionId, summary, maxMessages)

    // Only two things are genuinely "waiting on a human": a question this plugin
    // is holding, and an open approval audit pair. A tool call with no result is
    // NOT one of them — a tool that is merely still running looks exactly the
    // same in the log, and reporting that as waiting made ordinary work look
    // stuck.
    let waiting = null
    let pendingTool = null

    if (awaiting.has(sessionId)) {
      const entry = awaiting.get(sessionId)
      waiting = {
        kind: 'user-question',
        toolName: 'ask_user_question',
        sinceSeq: null,
        detail: entry.questions,
        intercepted: true,
        waitedMs: Date.now() - entry.at,
      }
    } else if (running === true && view.approvals.size > 0) {
      const detail = []
      view.approvals.forEach((value, id) => {
        detail.push({
          id,
          toolName: value.toolName,
          callId: value.callId,
          reason: value.reason,
          sinceSeq: value.seq,
        })
      })
      waiting = {
        kind: 'approval',
        toolName: detail.length === 1 ? detail[0].toolName : null,
        sinceSeq: detail.length === 1 ? detail[0].sinceSeq : null,
        detail,
        intercepted: false,
      }
    }

    // Informational only: which tool is executing right now. This does not make
    // the session "waiting".
    if (running === true && view.pendingCalls.size > 0) {
      let lastId = null
      for (const id of view.callOrder) {
        if (view.pendingCalls.has(id)) lastId = id
      }
      if (lastId !== null) {
        const entry = view.pendingCalls.get(lastId)
        pendingTool = { name: entry.name, sinceSeq: entry.seq, executing: true }
      }
    }

    return {
      sessionId,
      running,
      status: running === true ? (waiting ? 'waiting' : 'running') : 'idle',
      waiting,
      pendingTool,
      takeover: takeoverSessions.has(sessionId),
      cwd: summary && summary.cwd ? String(summary.cwd) : null,
      source: view.source,
      cursor: view.cursor,
      pageRecords: view.pageRecords,
      lastSeq: view.lastSeq,
      lastEventType: view.lastEventType,
      lastEventTime: view.lastEventTime,
      assistantCount: view.assistantCount,
      output: view.lastAssistant ? view.lastAssistant.text : '',
      outputSeq: view.lastAssistant ? view.lastAssistant.seq : null,
    }
  }

  ctx.effect(() =>
    web.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        if (!isLoopback(req)) {
          reply(res, 403, { ok: false, error: 'dsh-mcp-bridge only serves loopback callers' })
          return
        }
        if (!isAuthorized(req, token)) {
          reply(res, 401, { ok: false, error: 'missing or invalid x-dsh-bridge-token' })
          return
        }

        const rawUrl = req.url || ROUTE_PREFIX
        const route = rawUrl.split('?')[0].replace(/\/$/, '')
        const query = parseQuery(rawUrl)
        const method = String(req.method || 'GET').toUpperCase()

        if (route === `${ROUTE_PREFIX}/ping`) {
          reply(res, 200, {
            ok: true,
            data: { bridge: name, version: '0.4.2', tokenRequired: Boolean(token) },
          })
          return
        }

        if (route === `${ROUTE_PREFIX}/list`) {
          const result = await safe(async () => {
            const items = summarizeSessions(await listAll(), query.cwd || null)
            return { count: items.length, items: items.slice(0, 60) }
          })
          reply(res, 200, result)
          return
        }

        if (route === `${ROUTE_PREFIX}/questions`) {
          const pending = []
          awaiting.forEach((value, key) =>
            pending.push({ sessionId: key, questions: value.questions, waitedMs: Date.now() - value.at }),
          )
          reply(res, 200, {
            ok: true,
            data: { pending, takeover: Array.from(takeoverSessions), events: interceptionLog },
          })
          return
        }

        if (route === `${ROUTE_PREFIX}/answer`) {
          const raw = method === 'POST' ? await readRequestBody(req) : ''
          const result = await safe(async () => {
            let args = {}
            try {
              args = JSON.parse(raw || '{}')
            } catch {
              args = {}
            }
            const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
            const answers = Array.isArray(args.answers) ? args.answers : []
            const entry = awaiting.get(sessionId)
            if (!entry) throw new Error('no pending question for this session')
            entry.resolve(answers)
            return { sessionId, delivered: answers.length }
          })
          reply(res, 200, result)
          return
        }

        if (route === `${ROUTE_PREFIX}/takeover`) {
          const raw = method === 'POST' ? await readRequestBody(req) : ''
          const result = await safe(async () => {
            let args = {}
            try {
              args = JSON.parse(raw || '{}')
            } catch {
              args = {}
            }
            const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
            if (!sessionId) throw new Error('sessionId is required')
            if (args.enabled === false) takeoverSessions.delete(sessionId)
            else takeoverSessions.add(sessionId)
            return { sessionId, takeover: takeoverSessions.has(sessionId) }
          })
          reply(res, 200, result)
          return
        }

        if (route === `${ROUTE_PREFIX}/attach-all`) {
          const result = await safe(async () => attachAllOrphans())
          reply(res, 200, result)
          return
        }

        if (route === `${ROUTE_PREFIX}/delegate`) {
          const raw = method === 'POST' ? await readRequestBody(req) : ''
          const result = await safe(async () => {
            let args = {}
            try {
              args = JSON.parse(raw || '{}')
            } catch {
              args = {}
            }
            const workspace = typeof args.workspace === 'string' ? args.workspace : ''
            const instruction = typeof args.instruction === 'string' ? args.instruction : ''
            if (!instruction.trim()) throw new Error('instruction is required')

            let sessionId = typeof args.sessionId === 'string' && args.sessionId ? args.sessionId : null
            let created = false
            if (sessionId === null) {
              const request = {}
              if (workspace) request.cwd = workspace
              if (typeof args.agentPreset === 'string' && args.agentPreset) {
                request.agentPreset = args.agentPreset
              }
              const value = await controller.create(request)
              sessionId = String(value.sessionId)
              created = true
            }

            // Group it before the first prompt, so the GUI lists the session
            // under its workspace from the very start.
            const grouping = await attachToWorkspace(sessionId, workspace)

            // Mark takeover BEFORE the prompt so the very first question is
            // already intercepted rather than racing the agent.
            if (args.takeover === true) takeoverSessions.add(sessionId)

            let baselineSeq = 0
            try {
              baselineSeq = cursorOf(summaryOf(await listAll(), sessionId)) || 0
            } catch {
              baselineSeq = 0
            }

            const requestId = nextRequestId()
            await controller.prompt(
              {
                requestId,
                sessionId,
                mode: args.mode === 'steer' ? 'steer' : 'queue',
                content: [{ type: 'text', text: instruction }],
              },
              newSignal(),
            )

            return {
              sessionId,
              created,
              requestId,
              accepted: true,
              baselineSeq,
              takeover: takeoverSessions.has(sessionId),
              workspace: workspace || null,
              grouping,
            }
          })
          reply(res, 200, result)
          return
        }

        if (route === `${ROUTE_PREFIX}/poll`) {
          const result = await safe(async () => {
            const sessionId = query.sessionId || ''
            if (!sessionId) throw new Error('sessionId is required')
            return await buildStatus(sessionId, Number(query.max || DEFAULT_PAGE_MESSAGES))
          })
          reply(res, 200, result)
          return
        }

        if (route === `${ROUTE_PREFIX}/cancel`) {
          const raw = method === 'POST' ? await readRequestBody(req) : ''
          const result = await safe(async () => {
            let args = {}
            try {
              args = JSON.parse(raw || '{}')
            } catch {
              args = {}
            }
            const sessionId =
              typeof args.sessionId === 'string' ? args.sessionId : query.sessionId || ''
            if (!sessionId) throw new Error('sessionId is required')
            const value = await controller.cancel({ sessionId })
            return {
              sessionId,
              accepted: value && value.accepted === true,
              note: 'Only the active turn is cancelled; queued messages are not dropped.',
            }
          })
          reply(res, 200, result)
          return
        }

        if (route === `${ROUTE_PREFIX}/approval`) {
          const raw = method === 'POST' ? await readRequestBody(req) : ''
          const result = await safe(async () => {
            let args = {}
            try {
              args = JSON.parse(raw || '{}')
            } catch {
              args = {}
            }
            const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
            if (!sessionId) throw new Error('sessionId is required')
            const mode = typeof args.mode === 'string' ? args.mode : ''

            if (mode === 'auto-approve') {
              autoApproveSessions.add(sessionId)
              // Registering is not the same as working: if this process has never
              // been asked for an approval, the plugin sits downstream of the
              // GUI's answerer and can never grant one. Say so rather than
              // reporting a silent success.
              const reachable = approvalDiagnostics.listenerHits > 0
              return {
                sessionId,
                mode,
                autoApprove: true,
                effective: reachable,
                warning: reachable
                  ? undefined
                  : 'approvalListener.listenerHits is 0: this plugin has never been consulted for an approval, ' +
                    'so it sits downstream of the GUI answerer and cannot grant one. Only "deny" or "gui" take effect here.',
              }
            }
            if (mode === 'gui' || mode === 'deny') {
              autoApproveSessions.delete(sessionId)
              const agents = ctx.get('agents')
              const approvalService = ctx.get('approval')
              if (agents === undefined || approvalService === undefined) {
                throw new Error('agents/approval services are unavailable')
              }
              const agent = agents.get(sessionId)
              if (agent === undefined) {
                throw new Error('no live agent for this session; prompt it once to resume it first')
              }
              const policy = mode === 'deny' ? 'never' : 'ask'
              approvalService.setPolicy(agent, policy)
              return {
                sessionId,
                mode,
                autoApprove: false,
                policy,
                appliesTo: 'subsequent approvals only',
                note:
                  'The policy takes effect at the agent next step. An approval that is already pending stays ' +
                  'pending — resolve it in the DSH GUI, or cancel the turn.',
              }
            }
            throw new Error("mode must be 'gui', 'deny' or 'auto-approve'")
          })
          reply(res, 200, result)
          return
        }

        if (route === `${ROUTE_PREFIX}/diagnostics`) {
          reply(res, 200, {
            ok: true,
            data: {
              version: '0.4.2',
              approvalListener: { ...approvalDiagnostics },
              autoApproveSessions: Array.from(autoApproveSessions),
              takeoverSessions: Array.from(takeoverSessions),
              awaitingQuestions: Array.from(awaiting.keys()),
            },
          })
          return
        }

        reply(res, 404, { ok: false, error: 'unknown route', route })
      },
    }),
  )

  console.log(`[dsh-mcp-bridge] mounted ${ROUTE_PREFIX} (tokenRequired=${Boolean(token)})`)
}
