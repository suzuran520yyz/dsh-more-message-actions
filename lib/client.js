// dsh-more-message-actions — Client half (web bundle), v1.0.0 (kernel rc.1 adaptation).
// Adds icon-style message action buttons to the chat view, in the same row
// as the built-in copy / branch buttons:
//   user messages    : 编辑 (保存 / 修改并重试) + 删除
//   assistant replies: 编辑 + 重试 + 高级重试 + 删除
//
// What changed in DSH rc.1 (and why this file was rewritten):
//  - The session-level "ConversationSnapshot" that previous versions read
//    (session.chat.nodes / turnEnds / derived assistant nodes…) no longer
//    exists on the client Session snapshot. This version therefore does NOT
//    read message bodies from a snapshot. The assistant entry point is the
//    official `conversation.chat.assistant-actions` list slot, which hands
//    every finalized assistant message its durable `messageId` (plus the
//    session scope). The host half resolves all bodies/locations from the
//    durable event log, so the client only needs message ids.
//  - The transcript DOM kept its flow markers (`data-chat-flow-kind`,
//    `data-chat-flow-key`, `data-chat-turn`) but dropped the old
//    `data-time-hover-root` grouping element. User-message buttons are
//    DOM-injected into the platform's icon-action row, located by the hashed
//    `*_actions` class token that the shipped MessageIconActions row uses.
//  - Tool-call/reasoning collapse was removed: rc.1 ships its own reasoning
//    and turn-process disclosures, so a second "collapse" toggle would fight
//    the platform UI.
//
// The mutation contract is unchanged: every action calls the host RPC
// POST /api/dsh-more-message-actions/inplace which rewrites the SAME session
// (no fork) and then the client re-syncs the history window.
//
// v0.5.1: user-message edit prefills the stored original text via the host's
// read-only `text` op (same durable source as the AI-edit chat-snapshot
// prefill); DOM scraping remains only as a fallback for old host halves.
// v0.5.2: `data-chat-flow-key` on user rows is the CONVERSATION key
// (`13:input-message<uuid>`), not the durable message id — user edit/delete
// always failed host lookup with "消息未找到" since v0.4.0. The DOM key is now
// mapped back through durableIdOfDomKey() (strip the `${kind.length}:${kind}`
// prefix) before any host call, so user prefill, edit and delete resolve.
// v1.0.0 (client-only wording): delete now removes ONLY the targeted message
// side — the confirmation dialogs and hints were updated to state that
// deleting an AI reply also removes its thinking/process and tool-call rows
// while the paired user question and every later message stay untouched.
window.__ModuleLoader__.load({
  id: 'dsh-more-message-actions',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    const React = require('react')
    const ReactDOM = require('react-dom')
    const {
      Tooltip,
      IconEditOutline16,
      IconRefreshOutline16,
      IconTrashOutline16,
      IconEnhanceOutline16
    } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'more-message-actions'
    const PLUGIN = 'dsh-more-message-actions'

    // Transcript flow markers kept by DSH rc.1 (ChatView flow item).
    const USER_FLOW_SELECTOR = '[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]'

    // Inline SVG glyphs for the DOM-injected user-message buttons (the same
    // 16px icon set the platform UI uses).
    const ICON_EDIT_PATH = 'M9.94076 1.34942C10.7047 0.90231 11.6503 0.902415 12.4143 1.34942C12.7061 1.52015 12.9688 1.79118 13.3104 2.13284C13.6521 2.47448 13.9231 2.73721 14.0939 3.02894C14.5408 3.79294 14.5409 4.73856 14.0939 5.50251C13.9231 5.79415 13.652 6.05704 13.3104 6.39861L6.65932 13.0497C6.28068 13.4284 6.00695 13.7108 5.66543 13.9097C5.32391 14.1085 4.94315 14.2074 4.42705 14.3498L3.24394 14.6761C2.77527 14.8054 2.34538 14.9262 2.00131 14.9684C1.65196 15.0112 1.17964 15.0013 0.810764 14.6325C0.441921 14.2637 0.432107 13.7913 0.47486 13.442C0.517035 13.0979 0.6379 12.668 0.767181 12.1993L1.09352 11.0162C1.23588 10.5001 1.33481 10.1193 1.5336 9.77784C1.7325 9.43632 2.0149 9.1626 2.39355 8.78395L9.04466 2.13284C9.38625 1.79126 9.64911 1.52016 9.94076 1.34942ZM15.5427 14.8398H7.55223L8.96707 13.425H15.5427V14.8398ZM3.39382 9.78422C2.965 10.213 2.84244 10.3436 2.75709 10.49C2.67183 10.6366 2.61862 10.8079 2.45733 11.3925L2.13099 12.5756C2.00183 13.0439 1.92194 13.3419 1.88863 13.5536C2.10041 13.5204 2.39872 13.4416 2.86764 13.3123L4.05075 12.9859C4.63544 12.8246 4.80669 12.7715 4.95323 12.6862C5.09968 12.6008 5.23022 12.4783 5.65905 12.0494L10.721 6.98644L8.45577 4.72121L3.39382 9.78422ZM11.7 2.57079C11.3774 2.38198 10.9777 2.38198 10.6551 2.57079C10.5602 2.62647 10.4487 2.72931 10.0449 3.13311L9.45604 3.72094L11.7213 5.98617L12.3102 5.39833C12.7139 4.99457 12.8168 4.88307 12.8725 4.78818C13.0613 4.46561 13.0612 4.06585 12.8725 3.74326C12.8169 3.64827 12.7146 3.53752 12.3102 3.13311C11.9057 2.72863 11.795 2.6264 11.7 2.57079Z'
    const ICON_TRASH_PATH = 'M14.4782 4.84067L14.2138 10.1152C14.1102 12.1872 14.067 13.0115 13.3866 13.9607C13.1044 14.3546 12.7498 14.6912 12.3424 14.9535C11.8239 15.2872 11.2415 15.4316 10.5585 15.4998C9.88727 15.5668 9.04946 15.5656 7.99998 15.5656C6.95051 15.5656 6.1127 15.5668 5.44142 15.4998C4.75851 15.4316 4.17602 15.2872 3.65753 14.9535C3.25012 14.6912 2.89559 14.3546 2.61332 13.9607C1.93296 13.0115 1.88979 12.1872 1.78619 10.1152L1.52179 4.84067L2.89006 4.77277L3.15343 10.0463C3.26221 12.2218 3.32452 12.6015 3.72646 13.1624C3.90825 13.4161 4.13686 13.6334 4.39927 13.8023C4.66204 13.9714 5.00263 14.0792 5.57825 14.1367C6.16562 14.1953 6.92298 14.1963 7.99998 14.1963C9.07699 14.1963 9.83434 14.1953 10.4217 14.1367C10.9973 14.0792 11.3379 13.9714 11.6007 13.8023C11.8631 13.6334 12.0917 13.4161 12.2735 13.1624C12.6755 12.6015 12.7378 12.2218 12.8465 10.0463L13.1099 4.77277L14.4782 4.84067ZM5.43011 6.22849H6.7994V11.3909H5.43011V6.22849ZM9.20056 6.22849H10.5699V11.3909H9.20056V6.22849ZM8.53597 0.434431C9.17976 0.434431 9.6522 0.426926 10.0966 0.571258C10.2357 0.616451 10.3717 0.672554 10.502 0.738948C10.9182 0.951107 11.2464 1.29099 11.7015 1.74612L12.4978 2.54136H15.3742V3.91169H0.625732V2.54136H3.50218L4.29845 1.74612C4.75358 1.29099 5.08174 0.951107 5.49801 0.738948C5.62831 0.672554 5.76425 0.616451 5.90334 0.571258C6.34776 0.426926 6.82021 0.434431 7.46399 0.434431H8.53597ZM7.46399 1.80476C6.73208 1.80476 6.51641 1.81187 6.32617 1.87369C6.25545 1.89667 6.18668 1.92533 6.12041 1.95907C5.96398 2.03878 5.82348 2.16253 5.44142 2.54136H10.5585C10.1765 2.16253 10.036 2.03878 9.87955 1.95907C9.81329 1.92533 9.74452 1.89667 9.6738 1.87369C9.48356 1.81187 9.26789 1.80476 8.53597 1.80476H7.46399Z'
    const ICON_REFRESH_PATH = 'M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z'
    const ICON_ENHANCE_PATHS = [
      'M14.9943 1.92389V3.32428H1.00598V1.92389H14.9943Z',
      'M14.9943 5.50784V6.90823H1.00598V5.50784H14.9943Z',
      'M14.9943 9.09177V10.4922H1.00598V9.09177H14.9943Z',
      'M8.93274 12.6757V14.0761H1.00598V12.6757H8.93274Z'
    ]
    function inlineIcon(pathD) {
      return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="' + pathD + '" fill="currentColor"/></svg>'
    }
    function inlineIconPaths(paths) {
      return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' + paths.map(function (p) { return '<path d="' + p + '" fill="currentColor"/>' }).join('') + '</svg>'
    }

    // ------------------------------------------------------------------
    // Locales
    // ------------------------------------------------------------------
    const zh = {
      'action.edit': '编辑',
      'action.retry': '重试',
      'action.advancedRetry': '高级重试',
      'action.delete': '删除',
      'edit.title.user': '编辑用户消息',
      'edit.title.assistant': '编辑 AI 回复',
      'edit.hint.user': '「保存」只修改这条用户消息的文本：原有 AI 回复及其后的所有内容保持不变（若想让 AI 按新文本重新回答，请点「修改并重试」）；「修改并重试」则原地截断后用新文本重新生成。不创建分叉。',
      'edit.hint.assistant': '「保存」只替换这条回复的可见文本，不调用模型：该回复原有的思考内容、思考链与工具调用过程，以及其后的所有内容都原样保留。不创建分叉，上下文立即生效。',
      'edit.save': '保存',
      'edit.saveAndRetry': '修改并重试',
      'edit.cancel': '取消',
      'edit.confirmClose': '确定要关闭编辑框吗？未保存的修改将丢失。',
      'edit.keepEditing': '继续编辑',
      'edit.discardClose': '放弃修改并关闭',
      'edit.saving': '正在处理…',
      'edit.failed': '操作失败：{reason}',
      'advancedRetry.title': '高级重试',
      'advancedRetry.placeholder': '输入你对 AI 回复的要求（例如：更简短、不要使用工具、用中文回答…）',
      'advancedRetry.submit': '按要求重试',
      'advancedRetry.hint': '将在此回复所在回合之前原地截断，并带着你的要求重新生成；原会话保留，不创建分叉。',
      'delete.title': '删除消息',
      'delete.confirm.user': '确定删除这条用户消息吗？只删除这条消息本身：它对应的 AI 回复（含思考/工具过程）以及之后的任何消息都保持不变（不影响相关消息与后续内容）。此操作不可撤销。',
      'delete.confirm.assistant': '确定删除这条 AI 回复吗？将连同删除它的思维链、思考过程与工具调用记录（即该回复所在的整个 AI 侧内容）；它对应的用户提问以及之后的所有消息都保持不变。此操作不可撤销。',
      'delete.ok': '删除',
      'delete.deleting': '正在删除…',
      'delete.failed': '删除失败：{reason}',
      'delete.hint': '「删除」只移除目标消息本身：删除 AI 回复会一并移除其思考过程与工具调用，但不会删除它对应的用户提问；删除用户消息不会删除其 AI 回复。两者都不影响之后的任何消息。',
      'error.title': '操作失败',
      'error.busy': '当前回合正在运行，请先停止再执行此操作'
    }
    const en = {
      'action.edit': 'Edit',
      'action.retry': 'Retry',
      'action.advancedRetry': 'Advanced retry',
      'action.delete': 'Delete',
      'edit.title.user': 'Edit user message',
      'edit.title.assistant': 'Edit AI reply',
      'edit.hint.user': '「Save」only changes the text of this user message: the original AI reply and everything after it stay as-is (use 「Save & retry」when the answer must be regenerated). 「Save & retry」truncates in place and re-answers with your edited text. No fork is created.',
      'edit.hint.assistant': '「Save」only replaces the visible reply text without calling the model: the original reasoning content, thinking chain and tool-call process of this reply, plus everything after it, are all preserved. No fork is created.',
      'edit.save': 'Save',
      'edit.saveAndRetry': 'Save & retry',
      'edit.cancel': 'Cancel',
      'edit.confirmClose': 'Close this editor? Unsaved changes will be lost.',
      'edit.keepEditing': 'Keep editing',
      'edit.discardClose': 'Discard changes & close',
      'edit.saving': 'Working…',
      'edit.failed': 'Failed: {reason}',
      'advancedRetry.title': 'Advanced retry',
      'advancedRetry.placeholder': 'Requirements for the new AI reply (e.g. be more concise, do not call tools, answer in Chinese…)',
      'advancedRetry.submit': 'Retry with requirements',
      'advancedRetry.hint': 'Truncates in place before this reply and regenerates with your requirements; the original session is kept, no fork is created.',
      'delete.title': 'Delete message',
      'delete.confirm.user': 'Delete this user message? Only this message is removed: its AI reply (including its thinking/tool-call process) and any later messages stay untouched (no effect on related or subsequent content). This cannot be undone.',
      'delete.confirm.assistant': 'Delete this AI reply? Its thinking chain, reasoning process and tool-call records are removed along with it (the whole AI side of this turn); the user question it answered and all later messages stay untouched. This cannot be undone.',
      'delete.ok': 'Delete',
      'delete.deleting': 'Deleting…',
      'delete.failed': 'Delete failed: {reason}',
      'delete.hint': '「Delete」only removes the targeted message: deleting an AI reply also removes its reasoning process and tool calls but never the paired user question; deleting a user message never removes its AI reply. Neither affects any later message.',
      'error.title': 'Operation failed',
      'error.busy': 'A turn is running; stop it before running this action'
    }

    // ------------------------------------------------------------------
    // Small utilities
    // ------------------------------------------------------------------
    function uid() {
      return Math.random().toString(36).slice(2) + Date.now().toString(36)
    }
    function messageOf(error) {
      if (error instanceof Error) return error.message
      try { return String(error) } catch (e) { return '<unrenderable error>' }
    }
    function makeStore(initial) {
      let state = initial
      const subs = new Set()
      return {
        getSnapshot: () => state,
        subscribe: (fn) => {
          subs.add(fn)
          return () => { subs.delete(fn) }
        },
        set: (next) => {
          state = next
          for (const fn of [...subs]) fn()
        }
      }
    }

    // ------------------------------------------------------------------
    // Overlay controller (module-level event bus for dialogs)
    // ------------------------------------------------------------------
    const overlay = makeStore(null)
    overlay.open = (payload) => overlay.set(Object.assign({ key: uid() }, payload))
    overlay.close = () => overlay.set(null)
    function showError(title, message) {
      overlay.open({ kind: 'error', title, message })
    }

    // ------------------------------------------------------------------
    // Services (filled in apply)
    // ------------------------------------------------------------------
    const services = { sessions: null, t: null }

    /** Current session id from the session list store (rc.1 keeps the API). */
    function currentSessionId() {
      const sessions = services.sessions
      try {
        const list = sessions && sessions.list && sessions.list.getSnapshot()
        return list ? list.current : undefined
      } catch (e) {
        return undefined
      }
    }

    /** Live "is a turn running" flag for one session (rc.1 SessionSnapshot.running). */
    function runningOf(sessionId) {
      const sessions = services.sessions
      if (!sessions || !sessionId) return false
      try {
        const binding = sessions.binding(sessionId)
        const session = binding && binding.session
        const snapshot = session && typeof session.getSnapshot === 'function' ? session.getSnapshot() : undefined
        return !!(snapshot && snapshot.running)
      } catch (e) {
        return false
      }
    }

    // ------------------------------------------------------------------
    // Assistant reply text lookup (edit-dialog prefill).
    //
    // rc.1 no longer exposes message bodies on the Session snapshot, but the
    // session-scoped chat snapshot (the `useChat` standard hook the
    // assistant-actions slot host provides) still carries every transcript
    // node. A finalized turn's `turn-tail` node aggregates the reply's text
    // blocks and links them to the durable message id:
    //   node.data.closing.finalNode.messageId === <messageId>
    //   node.data.closing.blocks            → text blocks
    // ------------------------------------------------------------------
    function assistantTextOf(blocks) {
      if (!Array.isArray(blocks)) return null
      const parts = []
      for (const block of blocks) {
        if (block !== null && typeof block === 'object' && block.kind === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      if (parts.length === 0) return null
      return parts.join('')
    }

    /** Best-effort final reply text for one assistant message id, from the chat snapshot. */
    function assistantMessageTextInChat(chatSnapshot, messageId) {
      if (!chatSnapshot || !messageId) return null
      let nodes = null
      try {
        if (chatSnapshot.nodes && typeof chatSnapshot.nodes.values === 'function') nodes = chatSnapshot.nodes.values()
      } catch (e) { nodes = null }
      if (!nodes) return null
      const tryNode = (node) => {
        const d = node && node.data
        if (!d || typeof d !== 'object') return null
        // Finalized turn-tail node: closing.finalNode.messageId ↔ closing.blocks.
        if (d.closing && d.closing.finalNode && d.closing.finalNode.messageId === messageId && Array.isArray(d.closing.blocks)) {
          const text = assistantTextOf(d.closing.blocks)
          if (text) return text
        }
        // Assistant step: the settled message object may live on data.finalNode
        // with its own blocks/content — accept it only when it is pure prose
        // (no reasoning/tool blocks could leak into the edit prefill).
        if (d.finalNode && d.finalNode.messageId === messageId) {
          const blocks = d.finalNode.blocks
          if (Array.isArray(blocks) && blocks.length > 0 && blocks.every((b) => b && typeof b === 'object' && b.kind === 'text' && typeof b.text === 'string')) {
            const candidate = blocks.map((b) => b.text).join('')
            if (candidate) return candidate
          }
          const contentCandidate = textOfContent(d.finalNode.content)
          if (contentCandidate) return contentCandidate
        }
        return null
      }
      try {
        for (const node of nodes) {
          const found = tryNode(node)
          if (found) return found
        }
      } catch (e) { /* ignore */ }
      return null
    }
    function textOfContent(content) {
      if (!Array.isArray(content)) return null
      const parts = []
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.length > 0 ? parts.join('') : null
    }

    // ------------------------------------------------------------------
    // Mutation verbs — IN-PLACE mode (no fork). The host rewrites the live
    // session log and its persisted artifact for the SAME session id; this
    // client half only calls the endpoint and resyncs the history window.
    // ------------------------------------------------------------------
    function apiInplace(payload) {
      return fetch('/api/dsh-more-message-actions/inplace', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      }).then(function (res) {
        return res.json().then(function (j) {
          if (!res.ok || j.error) throw new Error(j && j.error ? j.error : ('HTTP ' + res.status))
          return j
        })
      })
    }

    async function resyncSession(sessionId) {
      const sessions = services.sessions
      if (!sessions || !sessionId) return
      try {
        const binding = sessions.binding(sessionId)
        const session = binding && binding.session
        if (session && typeof session.resync === 'function') {
          await session.resync()
        }
      } catch (e) {
        console.warn('[' + PLUGIN + '] resync failed:', e)
      }
    }

    /** Guard: refuse mutations while the session is running (host guards too). */
    function ensureIdle(sessionId) {
      if (runningOf(sessionId)) {
        const reason = services.t ? services.t('error.busy') : 'busy'
        throw new Error(reason)
      }
    }

    async function submitRetry({ sessionId, messageId, requirement }) {
      ensureIdle(sessionId)
      await apiInplace({ sessionId, op: 'retry', messageId, requirement })
      await resyncSession(sessionId)
    }

    async function submitEditUser({ sessionId, messageId, text, mode }) {
      if (!text || text.trim() === '') throw new Error('edited text is empty')
      ensureIdle(sessionId)
      await apiInplace({
        sessionId,
        op: 'edit-user',
        messageId,
        text,
        mode: mode === 'save-and-retry' ? 'retry' : 'save'
      })
      await resyncSession(sessionId)
    }

    async function submitEditAssistant({ sessionId, messageId, text }) {
      if (!text || text.trim() === '') throw new Error('edited text is empty')
      ensureIdle(sessionId)
      await apiInplace({ sessionId, op: 'edit-ai', messageId, text })
      await resyncSession(sessionId)
    }

    async function submitDelete({ sessionId, messageId }) {
      ensureIdle(sessionId)
      await apiInplace({ sessionId, op: 'delete', messageId })
      await resyncSession(sessionId)
    }

    // ------------------------------------------------------------------
    // User-message action injection (DOM).
    //
    // rc.1 keeps the flow-item markers but replaced the old
    // `[data-time-hover-root]` grouping with a plain icon-action row that
    // carries the hashed `*_actions` CSS-module token. We locate that row and
    // append our buttons to it so they share the platform hover behaviour.
    // ------------------------------------------------------------------
    function makeIconButton(iconSvg, label, title, onClick, danger, disabled) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'mma-icon-btn' + (danger ? ' mma-icon-btn-danger' : '')
      btn.setAttribute('aria-label', label)
      btn.title = title || label
      btn.innerHTML = iconSvg
      if (disabled) btn.disabled = true
      btn.addEventListener('click', onClick)
      return btn
    }

    /** True for platform icon-action row elements (MessageIconActions). */
    function isActionsRow(el) {
      if (!el || !el.classList || el.classList.length === 0) return false
      if (el.classList.contains('mma-user-actions')) return false
      for (const token of el.classList) {
        if (token === 'actions' || token.endsWith('_actions') || token.endsWith('-actions')) return true
      }
      return false
    }

    /** The message icon-action row inside one flow item, if any. */
    function findActionsRow(flowItem) {
      if (!flowItem) return null
      // Direct descendants first (the row is a sibling of the bubble stack).
      for (const child of flowItem.children) {
        if (isActionsRow(child)) return child
      }
      for (const child of flowItem.children) {
        if (child.querySelector && child.querySelector('.mma-user-actions')) continue
        const found = child.querySelector && findActionsRowIn(child)
        if (found) return found
      }
      return null
    }
    function findActionsRowIn(root) {
      for (const el of root.querySelectorAll('*')) {
        if (isActionsRow(el)) return el
      }
      return null
    }

    /** Best-effort plain text of the user bubble for the edit prefill. */
    function userTextOfRow(flowItem) {
      try {
        const seen = new Set()
        const walk = (root, depth) => {
          if (depth > 2) return null
          for (const el of root.children) {
            if (seen.has(el)) continue
            seen.add(el)
            if (el.classList) {
              for (const token of el.classList) {
                if (token.indexOf('bubble') !== -1) {
                  const clone = el.cloneNode(true)
                  for (const removed of clone.querySelectorAll('button, [class*="actions"]')) removed.parentNode && removed.parentNode.removeChild(removed)
                  const text = (clone.innerText || clone.textContent || '').trim()
                  if (text) return text
                }
              }
            }
            const nested = walk(el, depth + 1)
            if (nested) return nested
          }
          return null
        }
        return walk(flowItem, 0)
      } catch (e) {
        return null
      }
    }

    /**
     * Map a transcript DOM flow key back to the durable message id.
     * DSH conversation nodes key user/steering rows with a composed engine key
     * — conversationContextKey(kind, id) = `${kind.length}:${kind}${id}`, e.g.
     * `13:input-message<uuid>` — so `data-chat-flow-key` is NOT the message id.
     * The durable id is everything after that prefix; keys that do not match
     * the pattern (legacy DOM where the key already is the id) pass through.
     */
    function durableIdOfDomKey(key) {
      if (typeof key !== 'string') return key
      const colon = key.indexOf(':')
      if (colon <= 0) return key
      const head = key.slice(0, colon)
      if (!/^\d+$/.test(head)) return key
      const kindLen = Number(head)
      const after = key.slice(colon + 1)
      if (after.length <= kindLen) return key
      return after.slice(kindLen)
    }

    function injectUserActions() {
      const t = services.t
      if (!t) return
      const sessionId = currentSessionId()
      const running = sessionId ? runningOf(sessionId) : false
      const items = document.querySelectorAll(USER_FLOW_SELECTOR)
      for (const item of items) {
        try {
          // Skip echoes / pending steering bubbles (no durable node yet).
          if (item.hasAttribute('data-pending-steering') || item.hasAttribute('data-submission-echo')) continue
          const key = item.dataset.chatFlowKey || item.dataset.chatAnchorKey
          if (!key) continue
          const messageId = durableIdOfDomKey(key)
          const actionsRow = findActionsRow(item)
          const anchor = actionsRow || item
          let container = anchor.querySelector(':scope > .mma-user-actions') || (actionsRow ? null : anchor.querySelector('.mma-user-actions'))
          if (container) {
            // React may have re-rendered the row; keep the injected buttons in
            // sync with the running state.
            for (const btn of container.querySelectorAll('button')) btn.disabled = running
            continue
          }
          // DOM text is only a fallback: the dialog text is (re)filled from the
          // durable log via the host `text` peek, like the AI-edit prefill.
          const fallbackText = userTextOfRow(item) || ''
          container = document.createElement('div')
          container.className = 'mma-user-actions'
          container.appendChild(makeIconButton(inlineIcon(ICON_EDIT_PATH), t('action.edit'), t('action.edit'), () => {
            if (runningOf(sessionId)) { showError(t('action.edit'), t('error.busy')); return }
            openUserEditDialog(sessionId, messageId, fallbackText)
          }, false, running))
          container.appendChild(makeIconButton(inlineIcon(ICON_TRASH_PATH), t('action.delete'), t('action.delete'), () => {
            if (runningOf(sessionId)) { showError(t('action.delete'), t('error.busy')); return }
            overlay.open({ kind: 'delete-user', sessionId, messageId })
          }, true, running))
          anchor.appendChild(container)
        } catch (e) {
          console.error('[' + PLUGIN + '] user injection error:', e)
        }
      }
    }

    /**
     * Open the user-message edit dialog prefilled with the STORED original text
     * (the same durable source the AI edit uses). The DOM-scraped text only
     * serves as a fallback when the host peek fails (e.g. old host half).
     */
    async function openUserEditDialog(sessionId, messageId, fallbackText) {
      let text = fallbackText
      try {
        const result = await apiInplace({ sessionId, op: 'text', messageId })
        if (result && typeof result.text === 'string') text = result.text
      } catch (err) {
        console.warn('[' + PLUGIN + '] message text peek failed; falling back to DOM text:', messageOf(err))
      }
      overlay.open({ kind: 'edit-user', sessionId, messageId, text: text || '' })
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------
    function ensureStyles() {
      const tagId = PLUGIN + '/styles'
      if (document.querySelector('style[data-plugin-css="' + tagId + '"]')) return
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN
      tag.dataset.pluginCss = tagId
      tag.textContent = [
        '.mma-actions{display:inline-flex;align-items:center;gap:2px;margin:0 2px}',
        '.mma-user-actions{display:inline-flex;align-items:center;gap:2px}',
        '.mma-icon-btn{width:28px;height:28px;color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;background:transparent;border:none;border-radius:28px;display:inline-flex;justify-content:center;align-items:center;padding:6px;flex:none}',
        '.mma-icon-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));color:var(--dsw-alias-label-secondary,#cbd5e1)}',
        '.mma-icon-btn:disabled{opacity:.4;cursor:default}',
        '.mma-icon-btn-danger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary,#f87171)}',
        '.mma-modal-backdrop{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:24px}',
        '.mma-modal{position:relative;width:min(560px,100%);max-height:80vh;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-surface-1,#18181b);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.35);padding:16px;color:var(--dsw-alias-label-primary,#e5e7eb)}',
        '.mma-modal-wide{width:min(720px,100%)}',
        '.mma-modal-title{font-size:15px;font-weight:600}',
        '.mma-modal-body{display:flex;flex-direction:column;gap:8px}',
        '.mma-textarea{width:100%;min-height:220px;max-height:55vh;resize:vertical;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.18));border-radius:8px;background:var(--dsw-alias-fill-primary,#202023);color:var(--dsw-alias-text-primary,#e5e7eb);font:inherit;font-size:14px;line-height:1.7;padding:10px 12px}',
        '.mma-textarea:focus{outline:2px solid var(--dsw-alias-accent,#4c9aff);outline-offset:-1px}',
        '.mma-row{display:flex;align-items:center;gap:8px;justify-content:flex-end;flex-wrap:wrap}',
        '.mma-btn-primary{appearance:none;border:none;border-radius:8px;background:var(--dsw-alias-accent,#4c9aff);color:var(--dsw-alias-text-on-accent,#fff);font:inherit;font-size:13px;line-height:28px;padding:0 14px;cursor:pointer}',
        '.mma-btn-primary:hover{filter:brightness(1.08)}',
        '.mma-btn-primary:disabled{opacity:.55;cursor:default}',
        '.mma-btn-ghost{appearance:none;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.18));border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary,#9ca3af);font:inherit;font-size:13px;line-height:26px;padding:0 12px;cursor:pointer}',
        '.mma-btn-ghost:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
        '.mma-btn-danger-solid{appearance:none;border:none;border-radius:8px;background:var(--dsw-alias-state-error-primary,#e5484d);color:#fff;font:inherit;font-size:13px;line-height:28px;padding:0 14px;cursor:pointer}',
        '.mma-btn-danger-solid:disabled{opacity:.55;cursor:default}',
        '.mma-error{font-size:12px;line-height:1.5;color:var(--dsw-alias-state-error-primary,#e5484d)}',
        '.mma-hint{font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#6b7280)}',
        '.mma-confirm-overlay{position:absolute;inset:0;z-index:1;border-radius:12px;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}',
        '.mma-confirm-card{width:100%;display:flex;flex-direction:column;gap:12px;background:var(--dsw-alias-surface-2,#202023);border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,.12));border-radius:10px;padding:16px;box-shadow:0 8px 24px rgba(0,0,0,.35)}',
        '.mma-confirm-text{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#e5e7eb)}'
      ].join('\n')
      document.head.appendChild(tag)
    }

    // ------------------------------------------------------------------
    // React components
    // ------------------------------------------------------------------
    function IconButton({ icon, label, title, onClick, disabled, danger }) {
      return React.createElement(Tooltip, { label: title || label, side: 'bottom' },
        React.createElement('button', {
          type: 'button',
          className: 'mma-icon-btn' + (danger ? ' mma-icon-btn-danger' : ''),
          'aria-label': label,
          onClick,
          disabled: disabled || false
        }, icon)
      )
    }

    /**
     * Assistant actions entry rendered by the platform's
     * `conversation.chat.assistant-actions` list slot for every finalized
     * assistant message. The slot host supplies the durable `messageId`
     * (owner props) plus the session scope; the host half resolves the target
     * message and its surrounding turn from that id. The edit-dialog prefill
     * is read from the session chat snapshot (`useChat` standard hook) via the
     * message's `turn-tail` node, mirroring the copy button's text source.
     */
    const AssistantActionsView = React.memo(function AssistantActionsView(props) {
      const messageId = props && props.messageId
      const sessionId = (props && props.sessionId) || currentSessionId()
      const t = props && typeof props.t === 'function' ? props.t : services.t
      // Reply text for the edit prefill: read the session chat snapshot when
      // the slot host supplies the useChat standard hook; otherwise the dialog
      // opens empty (host still replaces the whole reply with what is typed).
      // Unconditional hook call — keep it above every early return.
      const useChat = props && typeof props.useChat === 'function' ? props.useChat : null
      let chatSnapshot = undefined
      if (useChat) {
        try { chatSnapshot = useChat((snapshot) => snapshot) } catch (e) { chatSnapshot = undefined }
      }
      if (!messageId || !sessionId) return null
      const running = runningOf(sessionId)
      let replyText = null
      if (chatSnapshot) {
        try { replyText = assistantMessageTextInChat(chatSnapshot, messageId) } catch (e) { replyText = null }
      }

      const children = []
      children.push(React.createElement(IconButton, {
        key: 'edit',
        icon: React.createElement(IconEditOutline16, { size: 14 }),
        label: t('action.edit'),
        title: t('action.edit'),
        disabled: running,
        onClick: () => {
          if (runningOf(sessionId)) { showError(t('action.edit'), t('error.busy')); return }
          overlay.open({ kind: 'edit-assistant', sessionId, messageId, text: replyText })
        }
      }))
      children.push(React.createElement(IconButton, {
        key: 'retry',
        icon: React.createElement(IconRefreshOutline16, { size: 14 }),
        label: t('action.retry'),
        title: t('action.retry'),
        disabled: running,
        onClick: () => {
          if (runningOf(sessionId)) { showError(t('action.retry'), t('error.busy')); return }
          submitRetry({ sessionId, messageId }).catch((err) => {
            console.error('[' + PLUGIN + '] retry failed:', err)
            showError(t('action.retry'), t('edit.failed', { reason: messageOf(err) }))
          })
        }
      }))
      children.push(React.createElement(IconButton, {
        key: 'advancedRetry',
        icon: React.createElement(IconEnhanceOutline16, { size: 14 }),
        label: t('action.advancedRetry'),
        title: t('action.advancedRetry'),
        disabled: running,
        onClick: () => {
          if (runningOf(sessionId)) { showError(t('action.advancedRetry'), t('error.busy')); return }
          overlay.open({ kind: 'advanced-retry', sessionId, messageId })
        }
      }))
      children.push(React.createElement(IconButton, {
        key: 'delete',
        icon: React.createElement(IconTrashOutline16, { size: 14 }),
        label: t('action.delete'),
        title: t('action.delete'),
        danger: true,
        disabled: running,
        onClick: () => {
          if (runningOf(sessionId)) { showError(t('action.delete'), t('error.busy')); return }
          overlay.open({ kind: 'delete-assistant', sessionId, messageId })
        }
      }))
      return React.createElement('div', { className: 'mma-actions' }, children)
    })

    // ---- Dialog host -----------------------------------------------------
    function DialogShell({ title, onClose, children, busy, wide, onBackdropClick, backdropGuardRef }) {
      const handleBackdropClick = (e) => {
        if (e.target !== e.currentTarget || busy) return
        // A click on the backdrop right after a drag that started inside the
        // textarea is the tail of a text-selection gesture, not a close
        // intent — swallow it so selecting text never dismisses the dialog.
        if (backdropGuardRef && backdropGuardRef.current) {
          backdropGuardRef.current = false
          return
        }
        if (onBackdropClick) onBackdropClick()
        else onClose()
      }
      return React.createElement('div', {
        className: 'mma-modal-backdrop',
        onClick: handleBackdropClick
      }, React.createElement('div', {
        className: 'mma-modal' + (wide ? ' mma-modal-wide' : ''),
        role: 'dialog',
        'aria-modal': 'true'
      },
        React.createElement('div', { className: 'mma-modal-title' }, title),
        children
      ))
    }

    function EditDialog({ payload, t }) {
      const initialText = payload.text !== undefined && payload.text !== null ? payload.text : ''
      const [text, setText] = React.useState(initialText)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [confirmClose, setConfirmClose] = React.useState(false)
      const closeGuard = React.useRef(false)
      const isUser = payload.kind === 'edit-user'
      const dirty = text !== initialText
      const requestClose = () => { if (dirty) setConfirmClose(true); else overlay.close() }
      const run = async (mode) => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          if (isUser) await submitEditUser({ sessionId: payload.sessionId, messageId: payload.messageId, text, mode })
          else await submitEditAssistant({ sessionId: payload.sessionId, messageId: payload.messageId, text })
          overlay.close()
        } catch (err) {
          setError(messageOf(err))
          setBusy(false)
        }
      }
      const submit = (mode) => { if (text.trim() !== '') void run(mode) }
      const buttons = [
        React.createElement('button', {
          key: 'cancel', type: 'button', className: 'mma-btn-ghost',
          disabled: busy, onClick: () => overlay.close()
        }, t('edit.cancel'))
      ]
      if (isUser) {
        buttons.push(React.createElement('button', {
          key: 'save', type: 'button', className: 'mma-btn-primary',
          disabled: busy || text.trim() === '', onClick: () => submit('save')
        }, t('edit.save')))
        buttons.push(React.createElement('button', {
          key: 'saveAndRetry', type: 'button', className: 'mma-btn-primary',
          disabled: busy || text.trim() === '', onClick: () => submit('save-and-retry')
        }, t('edit.saveAndRetry')))
      } else {
        buttons.push(React.createElement('button', {
          key: 'save', type: 'button', className: 'mma-btn-primary',
          disabled: busy || text.trim() === '', onClick: () => submit('save')
        }, busy ? t('edit.saving') : t('edit.save')))
      }
      return React.createElement(DialogShell, {
        title: isUser ? t('edit.title.user') : t('edit.title.assistant'),
        onClose: () => overlay.close(),
        onBackdropClick: requestClose,
        backdropGuardRef: closeGuard,
        wide: true,
        busy
      },
        confirmClose
          ? React.createElement('div', {
              className: 'mma-confirm-overlay',
              onKeyDown: (e) => { if (e.key === 'Escape') { e.preventDefault(); setConfirmClose(false) } }
            },
              React.createElement('div', { className: 'mma-confirm-card' },
                React.createElement('div', { className: 'mma-confirm-text' }, t('edit.confirmClose')),
                React.createElement('div', { className: 'mma-row' },
                  React.createElement('button', { key: 'keep', type: 'button', className: 'mma-btn-primary', onClick: () => setConfirmClose(false) }, t('edit.keepEditing')),
                  React.createElement('button', { key: 'discard', type: 'button', className: 'mma-btn-ghost', onClick: () => overlay.close() }, t('edit.discardClose'))
                )
              )
            )
          : React.createElement('div', { className: 'mma-modal-body' },
          React.createElement('textarea', {
            className: 'mma-textarea',
            value: text,
            autoFocus: true,
            onChange: (e) => setText(e.target.value),
            // A drag that starts inside the textarea and ends on the backdrop
            // is a text-selection gesture, not a close intent — the guard
            // makes the trailing backdrop click a no-op.
            onMouseDown: () => { closeGuard.current = true },
            onMouseUp: () => { window.setTimeout(() => { closeGuard.current = false }, 0) },
            onKeyDown: (e) => {
              if (e.key === 'Escape') { e.preventDefault(); if (!busy) requestClose() }
              else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(isUser ? 'save' : 'save') }
            }
          }),
          error !== null ? React.createElement('div', { className: 'mma-error' }, t('edit.failed', { reason: error })) : null,
          React.createElement('div', { className: 'mma-hint' }, isUser ? t('edit.hint.user') : t('edit.hint.assistant')),
          React.createElement('div', { className: 'mma-row' }, buttons)
        )
      )
    }

    function AdvancedRetryDialog({ payload, t }) {
      const [requirement, setRequirement] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [confirmClose, setConfirmClose] = React.useState(false)
      const closeGuard = React.useRef(false)
      const dirty = requirement.trim() !== ''
      const requestClose = () => { if (dirty) setConfirmClose(true); else overlay.close() }
      const run = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          await submitRetry({ sessionId: payload.sessionId, messageId: payload.messageId, requirement })
          overlay.close()
        } catch (err) {
          setError(messageOf(err))
          setBusy(false)
        }
      }
      return React.createElement(DialogShell, {
        title: t('advancedRetry.title'),
        onClose: () => overlay.close(),
        onBackdropClick: requestClose,
        backdropGuardRef: closeGuard,
        wide: true,
        busy
      },
        confirmClose
          ? React.createElement('div', {
              className: 'mma-confirm-overlay',
              onKeyDown: (e) => { if (e.key === 'Escape') { e.preventDefault(); setConfirmClose(false) } }
            },
              React.createElement('div', { className: 'mma-confirm-card' },
                React.createElement('div', { className: 'mma-confirm-text' }, t('edit.confirmClose')),
                React.createElement('div', { className: 'mma-row' },
                  React.createElement('button', { key: 'keep', type: 'button', className: 'mma-btn-primary', onClick: () => setConfirmClose(false) }, t('edit.keepEditing')),
                  React.createElement('button', { key: 'discard', type: 'button', className: 'mma-btn-ghost', onClick: () => overlay.close() }, t('edit.discardClose'))
                )
              )
            )
          : React.createElement('div', { className: 'mma-modal-body' },
          React.createElement('textarea', {
            className: 'mma-textarea',
            value: requirement,
            autoFocus: true,
            onChange: (e) => setRequirement(e.target.value),
            onMouseDown: () => { closeGuard.current = true },
            onMouseUp: () => { window.setTimeout(() => { closeGuard.current = false }, 0) },
            onKeyDown: (e) => {
              if (e.key === 'Escape') { e.preventDefault(); if (!busy) requestClose() }
              else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void run() }
            },
            placeholder: t('advancedRetry.placeholder')
          }),
          error !== null ? React.createElement('div', { className: 'mma-error' }, t('edit.failed', { reason: error })) : null,
          React.createElement('div', { className: 'mma-hint' }, t('advancedRetry.hint')),
          React.createElement('div', { className: 'mma-row' },
            React.createElement('button', { key: 'cancel', type: 'button', className: 'mma-btn-ghost', disabled: busy, onClick: () => overlay.close() }, t('edit.cancel')),
            React.createElement('button', { key: 'submit', type: 'button', className: 'mma-btn-primary', disabled: busy || requirement.trim() === '', onClick: () => void run() },
              busy ? t('edit.saving') : t('advancedRetry.submit'))
          )
        )
      )
    }

    function DeleteDialog({ payload, t }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const isUser = payload.kind === 'delete-user'
      const run = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          await submitDelete({ sessionId: payload.sessionId, messageId: payload.messageId })
          overlay.close()
        } catch (err) {
          setError(messageOf(err))
          setBusy(false)
        }
      }
      return React.createElement(DialogShell, {
        title: t('delete.title'),
        onClose: () => overlay.close(),
        busy
      },
        React.createElement('div', { className: 'mma-modal-body' },
          React.createElement('div', { style: { fontSize: 13, lineHeight: 1.7 } },
            isUser ? t('delete.confirm.user') : t('delete.confirm.assistant')),
          React.createElement('div', { className: 'mma-hint' }, t('delete.hint')),
          error !== null ? React.createElement('div', { className: 'mma-error' }, t('delete.failed', { reason: error })) : null,
          React.createElement('div', { className: 'mma-row' },
            React.createElement('button', { key: 'cancel', type: 'button', className: 'mma-btn-ghost', disabled: busy, onClick: () => overlay.close() }, t('edit.cancel')),
            React.createElement('button', { key: 'delete', type: 'button', className: 'mma-btn-danger-solid', disabled: busy, onClick: () => void run() },
              busy ? t('delete.deleting') : t('delete.ok'))
          )
        )
      )
    }

    function ErrorDialog({ payload, t }) {
      return React.createElement(DialogShell, {
        title: payload.title || t('error.title'),
        onClose: () => overlay.close()
      },
        React.createElement('div', { className: 'mma-modal-body' },
          React.createElement('div', { style: { fontSize: 13, lineHeight: 1.7 } }, payload.message || ''),
          React.createElement('div', { className: 'mma-row' },
            React.createElement('button', { key: 'ok', type: 'button', className: 'mma-btn-primary', onClick: () => overlay.close() }, t('edit.cancel'))
          )
        )
      )
    }

    const OverlayHost = React.memo(function OverlayHost() {
      const current = React.useSyncExternalStore(overlay.subscribe, overlay.getSnapshot)
      const t = services.t
      if (!current || !t) return null
      let body = null
      if (current.kind === 'edit-user' || current.kind === 'edit-assistant') {
        body = React.createElement(EditDialog, { key: current.key, payload: current, t })
      } else if (current.kind === 'advanced-retry') {
        body = React.createElement(AdvancedRetryDialog, { key: current.key, payload: current, t })
      } else if (current.kind === 'delete-user' || current.kind === 'delete-assistant') {
        body = React.createElement(DeleteDialog, { key: current.key, payload: current, t })
      } else if (current.kind === 'error') {
        body = React.createElement(ErrorDialog, { key: current.key, payload: current, t })
      }
      if (!body) return null
      return ReactDOM.createPortal(body, document.body)
    })

    // ------------------------------------------------------------------
    // Apply
    // ------------------------------------------------------------------
    let disposed = false
    let observer = null
    let overlayRoot = null
    let rafPending = false

    function scheduleInjection() {
      if (rafPending || disposed) return
      rafPending = true
      requestAnimationFrame(() => {
        rafPending = false
        if (disposed) return
        try { injectUserActions() } catch (e) { console.error('[' + PLUGIN + '] user injection error:', e) }
      })
    }

    function apply(ctx) {
      if (globalThis.__dshMoreMessageActionsApplied === true) return
      globalThis.__dshMoreMessageActionsApplied = true
      disposed = false
      ctx.effect(() => () => {
        globalThis.__dshMoreMessageActionsApplied = undefined
        disposed = true
        if (observer) { try { observer.disconnect() } catch (e) { /* ignore */ } }
        if (overlayRoot) { try { overlayRoot.unmount() } catch (e) { /* ignore */ } }
        const hostEl = document.getElementById('dsh-more-message-actions-root')
        if (hostEl && hostEl.parentNode) hostEl.parentNode.removeChild(hostEl)
      }, PLUGIN + ': cleanup')

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), PLUGIN + ': dictionaries')
      services.t = ctx.locale.bind(NS)
      services.sessions = ctx.sessions

      ensureStyles()

      ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
        name: 'conversation.chat.assistant-actions',
        id: 'more-message-actions',
        order: 20,
        locale: NS,
        inject: () => ({})
      }, AssistantActionsView))

      // Overlay root for dialogs.
      const hostEl = document.createElement('div')
      hostEl.id = 'dsh-more-message-actions-root'
      document.body.appendChild(hostEl)
      overlayRoot = ReactDOM.createRoot(hostEl)
      overlayRoot.render(React.createElement(OverlayHost))

      // Watch the DOM for new / re-rendered message rows.
      observer = new MutationObserver(scheduleInjection)
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'data-chat-flow-kind', 'data-chat-flow-key', 'data-chat-anchor-key', 'data-chat-turn']
      })
      scheduleInjection()
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale', 'sessions']

    return module.exports
  }
})
