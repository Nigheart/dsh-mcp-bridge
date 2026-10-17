#!/usr/bin/env node
/**
 * DSH Agent Control — MCP stdio server.
 *
 * Relays the Model Context Protocol (stdio, newline-delimited JSON-RPC) to the
 * in-process DSH host relay (HTTP). The relay is mounted by the
 * dsh-mcp-relay Cordis plugin inside the *running* DSH instance, so everything
 * this server drives is the same live runtime the Web GUI is attached to.
 *
 * stdout carries protocol frames only; all diagnostics go to stderr.
 *
 * Waiting is handled deliberately: polling happens here, where it costs
 * nothing, and a session blocked on a human is surfaced immediately instead of
 * burning the caller's timeout. When takeover is on, the question is held for
 * the caller to answer via dsh_answer; otherwise it stays with the GUI.
 */

import { createInterface } from 'node:readline'

const RELAY = process.env.DSH_RELAY_URL || 'http://127.0.0.1:3080/dsh-relay'
const RELAY_TOKEN = process.env.DSH_RELAY_TOKEN || ''
const DEFAULT_TIMEOUT_MS = Number(process.env.DSH_RELAY_TIMEOUT_MS || 600000)
const POLL_INTERVAL_MS = Number(process.env.DSH_RELAY_POLL_MS || 2000)

const log = (...parts) => process.stderr.write(`[dsh-mcp-relay] ${parts.join(' ')}\n`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function callRelay(path, options = {}) {
  const init = { method: options.method || 'GET', headers: {} }
  if (RELAY_TOKEN) init.headers['x-dsh-relay-token'] = RELAY_TOKEN
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json; charset=utf-8'
    init.body = JSON.stringify(options.body)
  }
  let response
  try {
    response = await fetch(RELAY + path, init)
  } catch (error) {
    // A bare "fetch failed" tells the operator nothing. Name the address and the
    // two things that are almost always wrong: DSH is not running, or this shim
    // is pointed at a different port than the Web profile listens on.
    const reason = String(error && error.message ? error.message : error)
    throw new Error(
      `cannot reach the DSH relay at ${RELAY} (${reason}). Check that DSH is running, and that ` +
        'DSH_RELAY_URL matches the port its Web profile listens on — DSH itself defaults to 3080, ' +
        'but a profile may set another port in its cordis.patch.yml.',
    )
  }
  const text = await response.text()
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error(`relay returned non-JSON (HTTP ${response.status}): ${text.slice(0, 300)}`)
  }
  if (payload && payload.ok === false) throw new Error(payload.error || 'relay reported an error')
  return payload && payload.ok === true ? payload.data : payload
}

const pollOnce = (sessionId) => callRelay(`/poll?sessionId=${encodeURIComponent(sessionId)}`)

/**
 * Wait for the turn started after `baselineSeq`.
 *
 * Returns as soon as the turn completed or the session is blocked on a human
 * (`status === 'waiting'`). The second case must not consume the timeout,
 * because no amount of waiting resolves it.
 */
async function waitForSettle(sessionId, baselineSeq, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let view = await pollOnce(sessionId)

  while (Date.now() < deadline) {
    if (view && view.status === 'waiting') return { outcome: 'waiting', view }
    if (view && view.running === false && Number(view.lastSeq || 0) > baselineSeq) {
      return { outcome: 'completed', view }
    }
    await sleep(POLL_INTERVAL_MS)
    view = await pollOnce(sessionId)
  }
  return { outcome: 'timeout', view }
}

function summarizeView(view) {
  if (!view) return {}
  return {
    running: view.running === true,
    status: view.status,
    takeover: view.takeover === true,
    pendingTool: view.pendingTool,
    lastSeq: view.lastSeq,
    lastEventType: view.lastEventType,
    assistantCount: view.assistantCount,
    cwd: view.cwd,
    cursor: view.cursor,
    readSource: view.source,
  }
}

function waitingNotice(view) {
  const waiting = view && view.waiting
  if (!waiting) return undefined
  if (waiting.intercepted === true) {
    return (
      'DSH asked a question and takeover is holding it for YOU. Answer it with ' +
      'dsh_answer({ sessionId, answers }), using the question ids shown in waiting.detail. ' +
      'If nobody answers within the takeover window the question falls back to the DSH GUI.'
    )
  }
  if (waiting.kind === 'approval') {
    const tools = (waiting.detail || []).map((entry) => entry.toolName).filter(Boolean)
    const what = tools.length > 0 ? `the tool "${tools.join('", "')}"` : 'a tool call'
    return (
      `DSH is blocked on an approval request for ${what}. This approval is ALREADY pending, so it can only be ` +
      'resolved by a person in the DSH GUI, or abandoned with dsh_cancel. ' +
      'dsh_approval changes how FUTURE approvals are handled, not this one: "deny" makes later ones fail at once, ' +
      '"gui" leaves them to the GUI. waiting.detail carries the reason DSH gave for asking.'
    )
  }
  if (waiting.kind === 'user-question') {
    return (
      'DSH is blocked waiting for a HUMAN to answer its question, and the answerer is the DSH Web GUI. ' +
      'Nobody can answer it from here: tell the user to answer it in the DSH GUI, then call dsh_poll again. ' +
      'Turning takeover on for this session (dsh_delegate with takeover) would route such questions to you instead.'
    )
  }
  return `DSH reported an unrecognised wait state (${waiting.kind}); call dsh_poll again to re-read it.`
}

function textBlock(text) {
  return { content: [{ type: 'text', text }] }
}

const TOOLS = [
  {
    name: 'dsh_list_sessions',
    description:
      'List sessions of the running DSH instance, optionally filtered to one workspace. ' +
      'Use this to discover an existing sessionId to continue, or to check what DSH is doing.',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: 'Absolute workspace path to filter by (exact match). Omit to list all sessions.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_delegate',
    description:
      'Delegate a task to a DSH agent, like handing work to a subagent. Creates a new session in the ' +
      'given workspace (or continues an existing one when sessionId is supplied), sends the instruction, ' +
      'and by default blocks until that turn finishes and returns its final output. ' +
      'Pass the returned sessionId back in later calls to keep working with the same DSH agent. ' +
      'If DSH blocks on a human question it returns status "waiting" immediately rather than hanging.',
    inputSchema: {
      type: 'object',
      properties: {
        instruction: { type: 'string', description: 'The task instruction for the DSH agent.' },
        workspace: {
          type: 'string',
          description: 'Absolute workspace path; used as cwd when creating a new session.',
        },
        sessionId: {
          type: 'string',
          description: 'Continue this existing DSH session instead of creating a new one.',
        },
        mode: {
          type: 'string',
          enum: ['queue', 'steer'],
          description:
            'queue (default) appends after the current turn; steer injects into the running turn.',
        },
        agentPreset: {
          type: 'string',
          description: 'Optional agent preset id for a newly created session.',
        },
        takeover: {
          type: 'boolean',
          description:
            'Default true. Routes this session\'s ask_user_question calls to you instead of the DSH GUI, ' +
            'so you answer them with dsh_answer. If you never answer, the question falls back to the GUI ' +
            'after about 3 minutes.',
        },
        wait: {
          type: 'boolean',
          description: 'Block until the turn completes (default true). Set false to return immediately.',
        },
        timeoutMs: {
          type: 'number',
          description: `Maximum time to wait for completion (default ${DEFAULT_TIMEOUT_MS}).`,
        },
      },
      required: ['instruction'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_answer',
    description:
      'Answer a question that DSH asked while takeover was on, letting its agent continue. ' +
      'Use the sessionId and the question ids from the "waiting" block returned by dsh_delegate or dsh_poll.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The DSH session that is waiting.' },
        answers: {
          type: 'array',
          description: 'One entry per question, keyed by the question id.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Question id from waiting.detail.' },
              selected: {
                type: 'array',
                items: { type: 'string' },
                description: 'Selected option labels.',
              },
              custom: { type: 'string', description: 'Free-text answer instead of a listed option.' },
            },
            required: ['id'],
            additionalProperties: false,
          },
        },
      },
      required: ['sessionId', 'answers'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_poll',
    description:
      'Check a DSH session: whether it is running, waiting on a human, or idle, plus its latest ' +
      'assistant output. Use after a dsh_delegate that timed out or returned "waiting", or to follow ' +
      'long-running work.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The DSH session to inspect.' },
        baselineSeq: {
          type: 'number',
          description: 'Only report completion once the log passes this cursor (from dsh_delegate).',
        },
        timeoutMs: {
          type: 'number',
          description: 'If greater than zero, block until settled, blocked-on-human, or this timeout elapses.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_approval',
    description:
      'Decide how a DSH session resolves approval requests — operations DSH refuses to run without a decision. ' +
      '"gui" (the default) leaves them to the DSH Web GUI for a person to answer. ' +
      '"auto-approve" grants them automatically for that session. ' +
      '"deny" makes them fail immediately, so an unattended delegation stops instead of blocking forever.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The DSH session to configure.' },
        mode: {
          type: 'string',
          enum: ['gui', 'auto-approve', 'deny'],
          description: 'How approval requests for this session should be resolved.',
        },
      },
      required: ['sessionId', 'mode'],
      additionalProperties: false,
    },
  },
  {
    name: 'dsh_cancel',
    description:
      'Cancel the active turn of a DSH session. Use it to abandon a turn that is blocked on an approval nobody ' +
      'can answer, or one that is running too long. Only the running turn stops; messages already queued inside ' +
      'DSH keep going.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The DSH session whose active turn should stop.' },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
]

async function callTool(name, args) {
  if (name === 'dsh_list_sessions') {
    const query = args.workspace ? `?cwd=${encodeURIComponent(args.workspace)}` : ''
    const data = await callRelay(`/list${query}`)
    return textBlock(JSON.stringify(data, null, 2))
  }

  if (name === 'dsh_delegate') {
    const accepted = await callRelay('/delegate', {
      method: 'POST',
      body: {
        instruction: args.instruction,
        workspace: args.workspace,
        sessionId: args.sessionId,
        mode: args.mode,
        agentPreset: args.agentPreset,
        takeover: args.takeover !== false,
      },
    })

    const baselineSeq = Number(accepted.baselineSeq || 0)
    if (args.wait === false) {
      return textBlock(
        JSON.stringify(
          {
            sessionId: accepted.sessionId,
            created: accepted.created,
            requestId: accepted.requestId,
            status: 'accepted',
            takeover: accepted.takeover === true,
            baselineSeq,
            note: 'Not waiting. Call dsh_poll with this sessionId and baselineSeq to collect the result.',
          },
          null,
          2,
        ),
      )
    }

    const timeoutMs = Number(args.timeoutMs || DEFAULT_TIMEOUT_MS)
    const { outcome, view } = await waitForSettle(accepted.sessionId, baselineSeq, timeoutMs)
    const output = view && view.output ? view.output : ''

    return textBlock(
      JSON.stringify(
        {
          sessionId: accepted.sessionId,
          created: accepted.created,
          status: outcome,
          output: outcome === 'waiting' ? '' : output,
          waiting: view && view.waiting ? view.waiting : undefined,
          action: waitingNotice(view),
          baselineSeq,
          ...summarizeView(view),
          note:
            outcome === 'timeout'
              ? 'Still running. Call dsh_poll again with the same sessionId.'
              : undefined,
        },
        null,
        2,
      ),
    )
  }

  if (name === 'dsh_answer') {
    const result = await callRelay('/answer', {
      method: 'POST',
      body: { sessionId: args.sessionId, answers: args.answers },
    })
    return textBlock(
      JSON.stringify(
        {
          sessionId: result.sessionId,
          delivered: result.delivered,
          note: 'The agent is resuming. Call dsh_poll with a baselineSeq to collect its output.',
        },
        null,
        2,
      ),
    )
  }

  if (name === 'dsh_approval') {
    const result = await callRelay('/approval', {
      method: 'POST',
      body: { sessionId: args.sessionId, mode: args.mode },
    })
    return textBlock(JSON.stringify(result, null, 2))
  }

  if (name === 'dsh_cancel') {
    const result = await callRelay('/cancel', {
      method: 'POST',
      body: { sessionId: args.sessionId },
    })
    return textBlock(JSON.stringify(result, null, 2))
  }

  if (name === 'dsh_poll') {
    const baselineSeq = Number(args.baselineSeq || 0)
    const timeoutMs = Number(args.timeoutMs || 0)
    const { outcome, view } =
      timeoutMs > 0
        ? await waitForSettle(args.sessionId, baselineSeq, timeoutMs)
        : { outcome: null, view: await pollOnce(args.sessionId) }

    const status =
      outcome !== null ? outcome : view && view.running ? view.status || 'running' : 'idle'

    return textBlock(
      JSON.stringify(
        {
          sessionId: args.sessionId,
          status,
          output: view && view.output ? view.output : '',
          waiting: view && view.waiting ? view.waiting : undefined,
          action: waitingNotice(view),
          ...summarizeView(view),
        },
        null,
        2,
      ),
    )
  }

  throw new Error(`unknown tool: ${name}`)
}

// ── MCP stdio transport ──────────────────────────────────────────────────────

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

async function handleRequest(method, params) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: (params && params.protocolVersion) || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'dsh-mcp-relay', version: '0.5.0' },
        // Injected into the client's context at handshake time, so the caller
        // learns the delegation model and the waiting contract without any
        // manual setup on the user's side.
        instructions: [
          'DSH Agent Control — drive DSH agents inside a running DeepSeek Harness instance.',
          'Treat a DSH session as a subagent you can delegate to: it keeps its own context across',
          'calls, works in the workspace you name, and returns a final answer.',
          '',
          '- dsh_list_sessions: find a sessionId to continue, or see what DSH is doing.',
          '- dsh_delegate: create a session in a workspace (or continue one via sessionId), send an',
          '  instruction, and block until the turn finishes, returning the final output.',
          '- dsh_answer: answer a question DSH asked, so its agent can resume.',
          '- dsh_approval: choose how a session resolves FUTURE approval requests.',
          '- dsh_cancel: cancel the active turn — the way out of a blocked approval.',
          '- dsh_poll: check a session that is still running or was left waiting.',
          '',
          'Workflow: dsh_delegate({ workspace, instruction }). Omit sessionId to start a new DSH',
          'agent; keep the returned sessionId and pass it back to continue the SAME agent (it',
          'remembers prior work). Then read status:',
          '  completed = output is the final answer.',
          '  timeout   = still working; call dsh_poll({ sessionId, baselineSeq }).',
          '  waiting   = blocked on a human. waiting.kind says which:',
          '    "user-question" + intercepted:true -> answer it with dsh_answer({ sessionId, answers })',
          '        using the ids in waiting.detail. If intercepted is false the question is sitting in',
          '        the DSH GUI instead and only a person there can answer it.',
          '    "approval" -> an operation needs a decision before DSH will run it, and this one is',
          '        already pending: only a person in the DSH GUI can approve it, or dsh_cancel',
          '        abandons the turn. waiting.detail carries the tool, the callId and the reason',
          '        DSH gave. dsh_approval({ sessionId, mode }) only changes FUTURE approvals:',
          '        "deny" rejects them at once, "gui" leaves them to the GUI.',
          '',
          'Rules: reuse a sessionId to continue the SAME line of work — a new session loses that context —',
          'but never reuse it for a different task. Pass an absolute path as workspace when creating a',
          'session. Resolve a waiting state yourself',
          '(answer the question, decide the approval) unless it genuinely needs a human. Do not poll',
          'in a short-timeout loop: dsh_delegate already blocks until the turn ends. A tool call that',
          'is merely still running is NOT a wait — the session stays "running" and reports a',
          'pendingTool field. DSH agents have their own sandbox policy and cannot write outside',
          'their workspace. Unanswered questions fall back to the DSH GUI after about three minutes.',
          '',
          'House rules for this deployment:',
          '- One task per session: start a new session for each new task, and a fresh one once the context',
          '  has grown long. Do not pile unrelated work into an old session.',
          '- Always pass an absolute workspace path when creating a session.',
          '- Model: DeepSeek 4.1 Flash with a vision plugin, so it can read images — but the results can be',
          '  inaccurate. Give it only simple image-reading tasks.',
          '- Never delegate visual design (drawing, web page layout, application UI, art): the model cannot',
          '  do it. For front-end work, supply a detailed written spec or a visual mockup first.',
          '- Do not check progress often; look in only when the user asks you to go faster.',
          '- Use these tools only when the user asks. If, after analysing the work, you think part of it suits',
          '  DSH, propose that and wait for agreement — do not start a delegation on your own initiative.',
          '- The user normally sets the workspace up in advance and names it, usually the same workspace you',
          '  (Codex) are already working in. If no workspace was given, ask whether to use your own workspace',
          '  before creating a session — do not assume it.',
        ].join('\n'),
      }
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const name = params && params.name
      const args = (params && params.arguments) || {}
      return await callTool(name, args)
    }
    case 'ping':
      return {}
    default:
      throw new Error(`method not found: ${method}`)
  }
}

let pending = 0

const rl = createInterface({ input: process.stdin })

rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return

  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    log('dropped unparseable line')
    return
  }

  // Notifications carry no id and expect no response.
  if (message.id === undefined || message.id === null) return

  pending += 1
  handleRequest(message.method, message.params)
    .then((result) => {
      send({ jsonrpc: '2.0', id: message.id, result })
    })
    .catch((error) => {
      const text = String(error && error.message ? error.message : error)
      log('request failed:', text)
      // Tool failures belong in the tool result so the model can react to them.
      if (message.method === 'tools/call') {
        send({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: `DSH relay error: ${text}` }], isError: true },
        })
      } else {
        send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: text } })
      }
    })
    .finally(() => {
      pending -= 1
    })
})

// A real MCP client keeps stdin open for the whole session; when it closes,
// drain any in-flight request so a piped test run still sees the response.
rl.on('close', () => {
  const waitForIdle = () => {
    if (pending === 0) {
      process.exit(0)
      return
    }
    setTimeout(waitForIdle, 50)
  }
  waitForIdle()
})

log(`ready — relay=${RELAY}`)
