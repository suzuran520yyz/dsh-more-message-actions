// dsh-more-message-actions — Host half, v1.0.0.
// IN-PLACE session surgery: retry / edit / delete WITHOUT fork.
//
// DSH's public surface is fork-based, but the live engine keeps everything in
// process: the host SessionStore holds the live Session (an event-sourced log),
// the Agent holds a phase machine that derives the next request from
// session.deriveMessages(), and the JSONL persistence coordinator tracks a
// per-session append cursor. With "at all costs" permission this host half:
//
//   1. waits for the agent to be idle and flushes pending writes,
//   2. for TEXT edits (edit-user save / edit-ai) replaces only the targeted
//      event's text blocks in the live log and re-encodes the whole artifact —
//      no truncation, so reasoning chains, tool-call rows and later messages
//      survive (see v0.5.0 below);
//   3. for destructive ops:
//      - retry / edit-user-retry truncates the live Session.log to the last
//        completed turn/end BEFORE the targeted message and resets the
//        Session's incremental caches (surface fold, derived messages, header
//        folds);
//      - delete removes ONLY the targeted message side from the log: for a
//        user/steering message that is its single event; for an AI reply that
//        is the reply's whole assistant-side turn content — its thinking chain
//        and steps, streamed chunk rows and settled message, and every
//        tool/call + tool/result row of the turn. Nothing else moves: the
//        paired user question, turn boundaries and every later message keep
//        their exact content and order — no tail truncation, no turn rebuild.
//   4. rewrites the persisted artifact (zstd JSONL) to the same prefix and
//      resets the coordinator's append cursor, so the next append stays
//      contiguous — same session id, no fork ever created,
//   5. then either triggers the Agent to regenerate (retry / edit-user-retry)
//      or ends there (delete / edit save).
//
// The client half calls POST /api/dsh-more-message-actions/inplace and then
// resyncs its history window. Every mutation backs up the artifact first
// (<file>.inplace-<ts>.bak) and rolls the log AND the artifact back to the
// pre-mutation state when any step of the surgery fails.
//
// WARNING: this reaches into engine internals (session.log, surfaceManager._state,
// agent.phase, coordinator.states). It is intentionally limited to idle
// sessions and balanced (completed-turn) cut points to keep the engine sound.
//
// v0.4.0 (DSH 0.1.2-rc.1): resolveTarget additionally locates user/steering
// messages by their durable data.id, because rc.1 logs carry message ids on
// user/message events and the rewritten client half now sends them.
// v0.4.1 (rc.1 host fixes): the live Session no longer exposes an iterable
// `session.events` — read the log via session.snapshotEvents()/session.log
// (sessionEvents helper); the JSONL encoder's encodeMaterialization now takes
// a { meta, inheritedEventCount } storage descriptor instead of the bare
// session header.
// v0.5.0 (non-destructive edits & minimal delete):
//  - edit-ai (save) no longer truncates the turn and re-appends a text-only
//    synthetic reply. It now swaps ONLY the text blocks of the target
//    assistant message event in place: the message's reasoning block, the
//    turn's tool-call process rows and every later message stay untouched.
//  - edit-user (save) likewise swaps only the user message text and keeps the
//    old reply plus all later context (use mode 'retry' when the answer must
//    be regenerated from the new text).
//  - delete no longer drops the whole target turn. It drops the target message
//    and everything after it, but rebuilds the target turn's earlier content
//    (the user question and prior thinking/tool steps) as one balanced
//    synthetic turn, so process content before the deleted message survives.
//  - every mutation now rolls the persisted artifact back to the pre-mutation
//    log when an append/flush step fails (not just the truncation step).
// v0.5.1 (user-edit prefill): the same endpoint gains a read-only op `text`
// that returns the durable plain text of one message (user/steering/assistant)
// from the event log. Editing a user message now auto-prefills the original
// text from this authoritative source — the same data the AI-edit dialog reads
// from the chat snapshot — instead of scraping the rendered DOM bubble.
// v0.5.2 (client-only): user rows carry a composed DOM key
// (`13:input-message<uuid>`) rather than the durable id; the client now strips
// the prefix (durableIdOfDomKey) before calling this half, so user prefill,
// edit and delete resolve. Host behavior unchanged.
// v1.0.0 (delete = single-message surgery): delete no longer truncates to the
// previous turn boundary and no longer touches anything after the target. It
// splices the targeted message out of the middle of the log — deleting a user
// message removes its single event, deleting an AI reply removes its entire
// assistant-side turn content (thinking/process steps, streamed chunk rows,
// the settled reply, tool calls and results) so the UI is left without a
// dangling process — then renumbers the surviving events so seq stays
// contiguous and rewrites the artifact. The paired user/AI message and every
// subsequent message are never touched.
import { randomUUID } from 'node:crypto'
import { copyFile, writeFile } from 'node:fs/promises'

export const name = 'dsh-more-message-actions'
export const inject = ['webServer', 'sessions', 'agents', 'sessionPersistence']

const MAX_BODY_BYTES = 1024 * 1024

// ---- Small helpers ---------------------------------------------------------

function msg(error) {
  return error && error.message ? error.message : String(error)
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

/**
 * Read the session's durable event log, engine-version tolerant.
 *
 * rc.1 (`@deepseek-ai/dsh-session`) keeps the events in the live Session's
 * `log` array and exposes an immutable `snapshotEvents()`; the legacy
 * `session.events` iterable this plugin was written against is gone.
 */
function sessionEvents(session) {
  if (!session) throw new Error('会话未加载')
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  if (Array.isArray(session.log)) return session.log.slice()
  const events = session.events
  if (Array.isArray(events)) return events.slice()
  if (events !== undefined && events !== null && typeof events[Symbol.iterator] === 'function') return [...events]
  throw new Error('无法读取会话事件日志（当前引擎接口不兼容）')
}

function originAllowed(req) {
  const origin = req.headers && req.headers.origin
  const host = req.headers && req.headers.host
  if (origin && host) {
    const allowed = new Set(['http://' + host, 'https://' + host])
    if (!allowed.has(origin)) return false
  }
  return true
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > MAX_BODY_BYTES) {
        reject(new Error('请求体过大'))
        if (typeof req.destroy === 'function') req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

// ---- Session surgery ------------------------------------------------------

/** The last index of a completed turn/end strictly before targetIdx, or -1. */
function lastTurnEndBefore(events, targetIdx) {
  let cut = -1
  for (let i = 0; i < targetIdx; i++) {
    if (events[i].type === 'turn/end') cut = i
  }
  return cut
}

/** Resolve the targeted message's event index from messageId or seq. */
function resolveTarget(events, args) {
  if (typeof args.messageId === 'string' && args.messageId) {
    const idx = events.findIndex((e) => {
      if (e.type === 'assistant/message') {
        return !!(e.data && ((e.data.message && e.data.message.id === args.messageId) || e.data.id === args.messageId))
      }
      if (e.type === 'user/message' || e.type === 'steering/message') {
        // rc.1 durable user events carry their own data.id; older logs may
        // nest the message object under data.message.
        return !!(e.data && ((e.data.id === args.messageId) || (e.data.message && e.data.message.id === args.messageId)))
      }
      return false
    })
    if (idx === -1) throw new Error('消息未找到')
    return idx
  }
  if (Number.isSafeInteger(args.seq) && args.seq >= 0 && args.seq < events.length) {
    const e = events[args.seq]
    if (e && (e.type === 'user/message' || e.type === 'assistant/message')) return args.seq
    throw new Error('目标位置不是消息事件')
  }
  throw new Error('消息未找到（缺少 messageId 或 seq）')
}

function plainTextOf(content) {
  if (!Array.isArray(content) || content.length === 0) return null
  let text = ''
  for (const block of content) {
    if (!block || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string') return null
    text += block.text
  }
  return text
}

/** Find the turn-opening user message before targetIdx (the main prompt). */
function findTurnUserMessage(events, targetIdx) {
  let turnStart = -1
  for (let i = 0; i < targetIdx; i++) {
    if (events[i].type === 'turn/start') turnStart = i
  }
  for (let i = turnStart + 1; i < targetIdx; i++) {
    const e = events[i]
    if (e.type !== 'user/message') continue
    const text = plainTextOf(e.data && e.data.content)
    if (text !== null) return { text, index: i, event: e }
  }
  throw new Error('该回合没有可重放的纯文本用户消息（可能包含图片附件）')
}

function lastTurnOf(session) {
  let last = 0
  for (const e of session.log) {
    if (e.type === 'turn/start' && e.data && Number.isSafeInteger(e.data.turn)) last = e.data.turn
  }
  return last
}

/** Truncate the live Session log in memory and reset every incremental cache. */
function truncateSession(session, keepLen) {
  session.log.length = keepLen
  session.eventsSnapshot = undefined
  session.headerFold = undefined
  session.headerFoldSeq = 0
  session.contextFold = undefined
  session.contextFoldSeq = 0
  session.derived = []
  session.derivedNodes = 0
  session.derivedGeneration = 0
  const sm = session.surfaceManager
  if (sm) {
    sm.log = session.log
    sm.baseSeq = 0
    sm._state = { nodes: [], replaceGeneration: 0 }
    sm._lastProcessedSeq = -1
    sm._pendingPlan = undefined
  }
}

/** Rebuild the persisted artifact from the truncated prefix and reset the append cursor. */
async function rewritePersisted(ctx, session, keepLen) {
  const backend = ctx.sessionPersistence
  if (!backend || typeof backend.encodeMaterialization !== 'function' || !backend.locate) {
    throw new Error('持久化后端不支持原地重写')
  }
  const loc = backend.locate(session.header)
  if (!loc || !loc.path) throw new Error('无法定位会话文件')

  const keptEvents = session.log.slice()
  // Reuse the backend's own encoder (header frame + event frame, zstd when
  // configured) so the rewritten artifact matches the physical format exactly.
  // rc.1's encoder takes a storage descriptor { meta, inheritedEventCount },
  // not the bare session header. When surgery removes events from inside the
  // fork-inherited prefix (single-message delete of an early message in a
  // forked session), the durable seed cut must shrink with the log, or a later
  // restore would fail "inherited event count exceeds its event log".
  const inheritedEventCount = Math.min(session.inheritedEventCount ?? 0, keepLen)
  session.inheritedEventCount = inheritedEventCount
  const storage = { meta: session.header, inheritedEventCount }
  const payload = await backend.encodeMaterialization(storage, keptEvents)

  const bak = loc.path + '.inplace-' + Date.now() + '.bak'
  await copyFile(loc.path, bak).catch(() => {})
  await writeFile(loc.path, payload)

  const coord = backend.coordinator
  if (coord) {
    const state = coord.states && coord.states.get(session.id)
    if (state) {
      state.cursor = keepLen
      state.materialized = true
    }
    if (coord.preparations && typeof coord.preparations.invalidate === 'function') {
      try { coord.preparations.invalidate(session.id) } catch {}
    }
  }
}

/** Put the live agent back to an idle phase aligned with the (new) log tail. */
function setAgentIdle(agent, session) {
  if (!agent) return
  const lastTurn = lastTurnOf(session)
  if (agent.phase) agent.phase = { kind: 'idle', lastTurn }
  if (agent.inbox && typeof agent.inbox.clear === 'function') {
    try { agent.inbox.clear() } catch {}
  }
  if ('requestHeaderLogged' in agent) agent.requestHeaderLogged = false
}

function makeUserMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user', rpcId: 'inplace-' + randomUUID(), clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  }
}

// ---- In-place content surgery (edit / delete, DSH rc.1 log shapes) --------

/** Recursively freeze a JSON value so rebuilt events match Session.append's deep-frozen events. */
function deepFreezeJson(value) {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) deepFreezeJson(value[key])
    Object.freeze(value)
  }
  return value
}

/**
 * Replace the text of a content-block array with a single edited text block.
 * Non-text blocks (reasoning / tool-call / image / …) are kept in order — this
 * is what preserves a reply's thinking chain, tool process and attachments
 * while its visible text is edited. Extra text blocks merge into the edited
 * one; when no text block exists the edited text is appended.
 */
function replaceContentText(content, text) {
  const out = []
  let replaced = false
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object' && block.type === 'text') {
        if (!replaced) {
          out.push({ type: 'text', text })
          replaced = true
        }
        continue
      }
      out.push(block)
    }
  }
  if (!replaced) out.push({ type: 'text', text })
  return out
}

/** Rebuild one log event around new data, keeping seq/time/surface metadata. */
function rebuiltEvent(original, data) {
  const event = { type: original.type, seq: original.seq, time: original.time, data }
  if (original.surfaceOp !== undefined) event.surfaceOp = original.surfaceOp
  if (original.sourceEventSeqs !== undefined) event.sourceEventSeqs = original.sourceEventSeqs
  return deepFreezeJson(event)
}

/** Swap the text of a user/steering message event in place (id/source kept). */
function swapUserMessageText(session, targetIdx, text) {
  const ev = session.log[targetIdx]
  const data = ev.data
  if (!data || typeof data !== 'object' || !Array.isArray(data.content)) throw new Error('目标消息内容无法编辑')
  session.log[targetIdx] = rebuiltEvent(ev, { ...data, content: replaceContentText(data.content, text) })
}

/** Swap the text blocks of an assistant message event in place (reasoning kept). */
function swapAssistantMessageText(session, targetIdx, text) {
  const ev = session.log[targetIdx]
  const data = ev.data
  const message = data && data.message
  if (!message || !Array.isArray(message.content)) throw new Error('目标 AI 回复内容无法编辑')
  session.log[targetIdx] = rebuiltEvent(ev, { ...data, message: { ...message, content: replaceContentText(message.content, text) } })
}

/** Roll the log AND the persisted artifact back to the pre-mutation state. */
async function rollbackSession(ctx, session, originalEvents) {
  session.log.splice(0, session.log.length, ...originalEvents)
  truncateSession(session, originalEvents.length)
  try {
    await rewritePersisted(ctx, session, originalEvents.length)
  } catch { /* the .inplace-*.bak backup remains for manual recovery */ }
}

/**
 * Event types that render as the ASSISTANT side of a turn (the reply itself,
 * its thinking chain / process steps and its tool calls). When an AI reply is
 * deleted these all go with it, so the UI is not left with a dangling process
 * block that lost its reply. User/steering messages, turn boundaries and
 * log-only rows (request headers, titles, inbox markers…) are NOT in the set
 * and stay.
 */
const ASSISTANT_SIDE_TYPES = new Set([
  'step/start',
  'step/end',
  'assistant/chunk',
  'assistant/message',
  'tool/call',
  'tool/result',
  'llm/retry',
  'llm/retry-started'
])

/**
 * Collect the log event indexes deleted for one targeted message (v1.0.0
 * single-message delete):
 *  - user / steering message → exactly its single event (its AI reply and all
 *    later content stay);
 *  - assistant reply → every assistant-side event of its enclosing turn:
 *    streamed chunks, the settled reply message, the whole thinking process
 *    (steps + their assistant messages) and every tool/call + tool/result row.
 *    The paired user question, the turn/start..turn/end boundaries and every
 *    later message are NOT part of the row and stay.
 */
function collectDeleteIndexes(events, targetIdx) {
  const target = events[targetIdx]
  if (!target) return []
  if (target.type !== 'assistant/message') return [targetIdx]

  let turn = -1
  let start = -1
  for (let i = targetIdx; i >= 0; i--) {
    const e = events[i]
    if (e.type === 'turn/start') {
      turn = e.data && Number.isSafeInteger(e.data.turn) ? e.data.turn : -1
      start = i
      break
    }
  }
  if (start === -1 || turn === -1) return [targetIdx]
  let end = events.length
  for (let i = targetIdx + 1; i < events.length; i++) {
    const e = events[i]
    if (e.type === 'turn/end' && e.data && e.data.turn === turn) {
      end = i
      break
    }
  }
  const indexes = []
  for (let i = start + 1; i < end; i++) {
    if (ASSISTANT_SIDE_TYPES.has(events[i].type)) indexes.push(i)
  }
  if (!indexes.includes(targetIdx)) indexes.push(targetIdx)
  return indexes
}

/** How many of the sorted dropped indexes lie strictly below `value`. */
function countDropsBelow(sortedDrops, value) {
  let lo = 0
  let hi = sortedDrops.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sortedDrops[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Rebuild one surviving event with its sequence number shifted to `newSeq`
 * (all drops before it). Numeric cross-references on later events — chunk
 * provenance (`sourceEventSeqs`) and positional `surfaceOp` replace ranges —
 * shift by the same number of dropped indexes below them, so the surviving log
 * stays contiguous AND internally consistent (seq === index, refs point at the
 * same events as before). The wrapped `data` is shared (already deep-frozen);
 * only the envelope is rebuilt and re-frozen.
 */
function rebaseEvent(event, newSeq, sortedDrops) {
  const out = { type: event.type, seq: newSeq, time: event.time, data: event.data }
  if (event.ignorable !== undefined) out.ignorable = event.ignorable
  if (event.sourceEventSeqs !== undefined) {
    out.sourceEventSeqs = event.sourceEventSeqs.map((seq) => seq - countDropsBelow(sortedDrops, seq))
  }
  if (event.surfaceOp !== undefined) {
    if (event.surfaceOp === 'append') {
      out.surfaceOp = 'append'
    } else if (event.surfaceOp && typeof event.surfaceOp === 'object') {
      out.surfaceOp = {
        op: 'replace',
        start: event.surfaceOp.start - countDropsBelow(sortedDrops, event.surfaceOp.start),
        end: event.surfaceOp.end - countDropsBelow(sortedDrops, event.surfaceOp.end)
      }
    }
  }
  return deepFreezeJson(out)
}

/**
 * Remove the given event indexes from the live log (v1.0.0 delete). The array
 * is rebuilt in place with every surviving event renumbered so `seq === index`;
 * events before the first removal keep their original object, events after it
 * get a rebased envelope. Returns the new log length.
 */
function spliceOutEvents(session, dropIndexes) {
  const sortedDrops = [...new Set(dropIndexes)].sort((a, b) => a - b)
  if (sortedDrops.length === 0) return session.log.length
  const original = session.log
  const rebuilt = new Array(original.length - sortedDrops.length)
  const drop = new Set(sortedDrops)
  let out = 0
  for (let i = 0; i < original.length; i++) {
    if (drop.has(i)) continue
    const event = original[i]
    rebuilt[out] = i === out ? event : rebaseEvent(event, out, sortedDrops)
    out += 1
  }
  session.log.splice(0, session.log.length, ...rebuilt)
  truncateSession(session, rebuilt.length)
  return rebuilt.length
}

// ---- Operation -------------------------------------------------------------

async function runInplace(ctx, args) {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
  if (!sessionId) throw new Error('缺少 sessionId')
  const op = typeof args.op === 'string' ? args.op : ''
  if (!['retry', 'edit-user', 'edit-ai', 'delete'].includes(op)) throw new Error('未知操作: ' + op)

  const session = ctx.sessions.get(sessionId)
  if (!session) throw new Error('会话未加载（请先在界面中打开该会话）')
  const agent = ctx.agents.get(sessionId)
  if (!agent) throw new Error('会话代理未加载')
  if (!agent.phase || agent.phase.kind !== 'idle') throw new Error('请先停止当前回合再执行该操作')

  // Drain any buffered writes so the artifact is complete before we rewrite it.
  await ctx.sessions.flush(session)

  const events = sessionEvents(session)
  const targetIdx = resolveTarget(events, args)

  // ---- edit-ai: swap ONLY the reply text. The reasoning block, the tool
  // ---- process and every later message stay untouched — no truncation.
  if (op === 'edit-ai') {
    const text = typeof args.text === 'string' ? args.text : ''
    if (!text || text.trim() === '') throw new Error('编辑后的文本为空')
    const te = events[targetIdx]
    if (!te || te.type !== 'assistant/message' || !te.data || !te.data.message) throw new Error('目标不是 AI 回复消息')
    swapAssistantMessageText(session, targetIdx, text)
    truncateSession(session, session.log.length) // reset incremental caches only
    try {
      await rewritePersisted(ctx, session, session.log.length)
    } catch (err) {
      await rollbackSession(ctx, session, events)
      throw err
    }
    return { ok: true, op: 'edit-ai', textReplaced: true }
  }

  // ---- edit-user save: swap ONLY the user message text; the old reply and
  // ---- everything after it stay. Use mode 'retry' to regenerate instead.
  if (op === 'edit-user' && args.mode !== 'retry') {
    const text = typeof args.text === 'string' ? args.text : ''
    if (!text || text.trim() === '') throw new Error('编辑后的文本为空')
    const te = events[targetIdx]
    if (!te || (te.type !== 'user/message' && te.type !== 'steering/message')) throw new Error('目标不是用户消息')
    swapUserMessageText(session, targetIdx, text)
    truncateSession(session, session.log.length)
    try {
      await rewritePersisted(ctx, session, session.log.length)
    } catch (err) {
      await rollbackSession(ctx, session, events)
      throw err
    }
    return { ok: true, op: 'edit-user', textReplaced: true }
  }

  // ---- delete (v1.0.0): remove ONLY the targeted message side. Deleting a
  // ---- user message removes its single event; deleting an AI reply removes
  // ---- its whole assistant-side turn content (thinking/process steps, the
  // ---- reply and its chunks, tool calls and results) so no dangling process
  // ---- remains. The paired message, turn boundaries and every later message
  // ---- are NOT touched — nothing is truncated after the target and nothing
  // ---- is rebuilt.
  if (op === 'delete') {
    const te = events[targetIdx]
    const ttype = te && te.type
    if (ttype !== 'user/message' && ttype !== 'steering/message' && ttype !== 'assistant/message') {
      throw new Error('目标不是可删除的消息')
    }
    const dropIndexes = collectDeleteIndexes(events, targetIdx)
    const newLen = spliceOutEvents(session, dropIndexes)
    try {
      await rewritePersisted(ctx, session, newLen)
    } catch (err) {
      await rollbackSession(ctx, session, events)
      throw err
    }
    setAgentIdle(agent, session)
    return { ok: true, op: 'delete', removedEvents: dropIndexes.length, truncatedTo: newLen }
  }

  // ---- Remaining ops (retry / edit-user retry) truncate to the last
  // ---- completed turn boundary BEFORE the targeted message.
  const keepLen = lastTurnEndBefore(events, targetIdx) + 1

  let userText = null
  if (op === 'retry') {
    userText = findTurnUserMessage(events, targetIdx).text
    if (typeof args.requirement === 'string' && args.requirement.trim() !== '') {
      userText = userText + '\n\n[重新回答要求]\n' + args.requirement.trim()
    }
  }

  // In-memory truncation.
  truncateSession(session, keepLen)
  try {
    await rewritePersisted(ctx, session, keepLen)
  } catch (err) {
    await rollbackSession(ctx, session, events)
    throw err
  }

  if (op === 'retry' || (op === 'edit-user' && args.mode === 'retry')) {
    const text = op === 'retry' ? userText : (typeof args.text === 'string' ? args.text : '')
    if (!text || text.trim() === '') throw new Error('重试文本为空')
    setAgentIdle(agent, session)
    agent.followup(makeUserMessage(text))
    return { ok: true, op, regenerating: true }
  }

  throw new Error('未知操作: ' + op)
}

// ---- Read-only message text peek (edit-dialog prefill) ---------------------

/** Join the text blocks of a content array (mirrors the AI prefill source). */
function joinedContentText(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') out += block.text
  }
  return out
}

/**
 * Return the durable plain text of one message from the event log. Read-only:
 * works while the session is idle or running, never mutates anything. Used by
 * the client to prefill the user-message edit dialog with the stored original
 * (the AI dialog already prefills from the client chat snapshot).
 */
async function peekMessageText(ctx, args) {
  const sessionId = typeof args.sessionId === 'string' ? args.sessionId : ''
  if (!sessionId) throw new Error('缺少 sessionId')
  const session = ctx.sessions.get(sessionId)
  if (!session) throw new Error('会话未加载（请先在界面中打开该会话）')
  const events = sessionEvents(session)
  const targetIdx = resolveTarget(events, args)
  const e = events[targetIdx]
  if (!e) throw new Error('消息未找到')
  let text = ''
  if (e.type === 'user/message' || e.type === 'steering/message') {
    text = joinedContentText(e.data && e.data.content)
  } else if (e.type === 'assistant/message') {
    text = joinedContentText(e.data && e.data.message && e.data.message.content)
  } else {
    throw new Error('目标不是消息')
  }
  return { ok: true, op: 'text', text }
}

// ---- Plugin apply ----------------------------------------------------------

/** Internal surgery surface for host self-checks (not part of the plugin API). */
export const __surgery = {
  collectDeleteIndexes,
  spliceOutEvents,
  rebaseEvent,
  countDropsBelow
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  const disposers = []

  if (webServer !== undefined) {
    const handle = async (req, res) => {
      if (!originAllowed(req)) {
        if (typeof req.resume === 'function') req.resume()
        json(res, 403, { error: '跨源请求被拒绝' })
        return
      }
      try {
        const args = await readBody(req)
        const result = args && args.op === 'text'
          ? await peekMessageText(ctx, args)
          : await runInplace(ctx, args || {})
        json(res, 200, result)
      } catch (err) {
        json(res, 400, { error: msg(err) })
      }
    }
    disposers.push(webServer.register({
      method: 'POST',
      kind: 'exact',
      path: '/api/dsh-more-message-actions/inplace',
      handler: handle
    }))
  }

  ctx.effect(() => () => {
    for (const dispose of disposers) dispose()
  }, 'dsh-more-message-actions: cleanup')
}
