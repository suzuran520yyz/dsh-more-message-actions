# dsh-more-message-actions — BUG 速查表

> 用途：功能故障时按这张表快速定位「问题出在哪个半部、哪一环、看哪里」。
> 适用内核基线：DSH **0.1.2-rc.1**（2026-09 起）。内核升级后优先查「D. 内核接口依赖清单」。
> 术语：**Host 半** = `lib/index.js`（服务端/引擎手术）；**Client 半** = `lib/client.js`（浏览器/按钮渲染）。

## 0. 一句话架构

```
按钮渲染(Client)  --POST /api/dsh-more-message-actions/inplace-->  Host
   assistant：conversation.chat.assistant-actions 槽(React)
   user      ：DOM 注入图标栏(MutationObserver)
                                               │
     Host：runInplace → resolveTarget(按 messageId/seq 定位事件)
       ├ [edit-ai / edit-user save] swap 目标事件 text 块 → 重写全量落盘（不截断）
       ├ [delete]（v1.0.0 单条删除）collectDeleteIndexes → spliceOutEvents
       │         （user/steering → 仅其单事件；assistant/message → 所在回合整个 AI 侧：
       │           step 行、思考过程消息与 chunk 行、tool/call + tool/result）
       │         → 后续事件重编号（seq==下标 保持连续）→ 重写全量落盘（不截断、不重建回合）
       └ [retry / edit-user-retry]
              → lastTurnEndBefore(找上一处 turn/end 平衡点)
              → truncateSession(截内存 log + 重置增量缓存)
              → rewritePersisted(重写 zstd JSONL + 重置游标)
              → agent.followup
  成功 → Client session.resync() 重拉历史窗口
```

所有操作**原地、同一 sessionId、不建分支**；每次落盘前先备份 `<会话文件>.inplace-<时间戳>.bak`，重写失败自动回滚内存日志。

## 1. 功能 → 会出错的部分（总表）

| 功能 | 负责半部 | 关键代码入口 | 可能出错环节 | 主要症状 | 排查入口 |
| --- | --- | --- | --- | --- | --- |
| AI 消息按钮显示 | Client | `ctx.slots.inject('conversation.chat.assistant-actions', …)` / `AssistantActionsView` | ①插件 entry 未激活（缺服务/挂起）②槽位契约变化 ③组件渲染抛错 ④`exports.inject` 服务名漂移 | AI 消息行没有编辑/重试/删除按钮 | 浏览器 console；插件清单(settings→plugins)看 entry 状态；对比官方 `message-feedback` 按钮是否还在 |
| 用户消息按钮显示 | Client | DOM 注入：`USER_FLOW_SELECTOR`、`findActionsRow`（`*_actions` 行）、`MutationObserver` | ①内核重写聊天 DOM（data-* 属性/图标栏类名变化）②`data-chat-flow-key` 取不到 ③行定位到错元素/重复注入 | 用户消息行没有编辑/删除按钮，或按钮重复/位置错 | console 中 `[dsh-more-message-actions] user injection error`；检查真实 DOM 类名/属性 |
| 编辑框/弹窗 | Client | `OverlayHost` → `EditDialog` 等（`#dsh-more-message-actions-root` portal） | portal 根缺失 / 组件渲染异常 / locale `t` 未绑定 | 点了没弹窗 / 弹窗空白 | console；`overlay.open` 是否被调用 |
| 编辑 AI 回复：原文预填 | Client | `AssistantActionsView` → `useChat` 快照 → `assistantMessageTextInChat`（turn-tail `closing.finalNode.messageId` ↔ `closing.blocks`） | ①槽位没给 `useChat` 标准 hook ②聊天快照节点结构变化 ③messageId 不落在 turn-tail 节点 | 弹窗打开是空的（不报错） | console；`chatSnapshot.nodes.values()` 里 turn-tail 节点结构 |
| 编辑用户消息：原文预填 | Client(+Host) | 点击编辑 → `openUserEditDialog` → `apiInplace({op:'text', messageId})` 取日志原文 → 打开弹窗；DOM 文本（`userTextOfRow`）仅作回退 | ①DOM key 是合成 key（`13:input-message<uuid>`）→ 必须经 `durableIdOfDomKey()` 剥前缀（v0.5.2 起）；②旧 Host 无 `text` op（自动回退 DOM 文本）；③会话未加载 | 弹窗没预填原文；console `message text peek failed…` | 检查发送的 messageId 是否 = `durableIdOfDomKey(data-chat-flow-key)`；Host 需 v0.5.1+ |
| 编辑用户消息（保存） | Host+Client | `submitEditUser`(mode=save) → Host `op:'edit-user'` → `swapUserMessageText`（只换文本，不截断） | messageId/seq 解析失败；事件 content 结构异常；落盘失败 | “消息未找到/操作失败/会话没变化” | Host 返回 error 文本；看 `resolveTarget`、`swapUserMessageText` |
| 编辑用户消息（修改并重试） | Host+Client | `submitEditUser`(mode=retry) → `agent.followup(makeUserMessage(text))` | 同上 + agent 侧：phase 被改写后 followup 不触发/回合不开始 | 截断了但 AI 不再回答 | 看 agent 是否收到 followup、`agent.phase` |
| 修改并重试 | Host+Client | `submitEditUser`(mode=retry) → 截断 → `agent.followup(makeUserMessage(text))` | agent 侧：phase 被改写后 followup 不触发/回合不开始 | 截断了但 AI 不再回答 | 看 agent 是否收到 followup、`agent.phase` |
| 重试 | Host+Client | `submitRetry` → `op:'retry'` → `findTurnUserMessage` → `agent.followup` | 回合开头找不到纯文本用户消息（附图/steering 等）；followup 链路 | “该回合没有可重放的纯文本用户消息” / 无回答 | 看 `findTurnUserMessage`；确认消息 content 为纯 text |
| 高级重试 | Host+Client | `submitRetry` + `requirement` 拼接进用户文本 | 同上；要求文本拼接处 | 同上 / 回答里没体现要求 | 检查拼接逻辑 `[重新回答要求]` |
| 编辑 AI 回复（保存） | Host+Client | `submitEditAssistant` → `op:'edit-ai'` → `swapAssistantMessageText`（只替换 text 块，不截断） | 目标事件不是 assistant/message；content 结构异常；落盘失败 | “目标不是 AI 回复消息/操作失败” | 看 `resolveTarget` + `swapAssistantMessageText`；编辑后思考/工具应保留 |
| 删除（用户/AI） | Host+Client | `submitDelete` → `op:'delete'` → `collectDeleteIndexes` + `spliceOutEvents`（user/steering 仅其单事件；assistant/message 为其所在回合整个 AI 侧：step、思考过程消息与 chunk 行、tool/call + tool/result）→ 后续事件重编号 + `rewritePersisted` | messageId 类型不匹配（user 走 `data.id`，assistant 走 `data.message.id`）；目标不是消息事件；assistant 目标所在回合范围找错（turn/start..turn/end 不闭合）；重编号/引用平移漏改（sourceEventSeqs、surfaceOp replace 的 start/end） | “消息未找到” / “目标不是可删除的消息” / 删除后日志 seq 不连续或重放报错 / AI 侧没删干净（残留过程块） | 核对 `resolveTarget`、`collectDeleteIndexes`（AI 回复应覆盖整个 AI 侧且不误删 user/steering 行与后续回合）、`rebaseEvent` 的引用平移；删除后 `snapshotEvents()` 中 `seq===下标` 且 turn/step 依旧平衡 |
| 操作后界面刷新 | Client | `resyncSession` → `binding.session.resync()` | rc.1 Session 无 `resync`/无 binding；服务未注入 | 后端成功但界面没变化 | console；确认 `ctx.sessions.binding(id).session` |
| 回合运行中禁止操作 | Client+Host | `runningOf` / `ensureIdle` / Host `agent.phase.kind!=='idle'` | sessions 快照无 `running` 字段 / agent 无 phase | 误允许或一律拒绝 | 看 SessionSnapshot.running / agent.phase |
| 历史消息预填/操作旧会话 | Client+Host | messageId ↔ DOM key ↔ 日志事件 | 旧日志事件无 `data.id`（只能靠 seq）；用户行 DOM key 为合成 key（需 `durableIdOfDomKey` 剥前缀，v0.5.2 起） | 用户消息操作报“消息未找到” | 日志事件格式（见 D 节事件形状）；DOM `data-chat-flow-key` 形如 `13:input-message<uuid>` |

## 2. 症状 → 可能原因速查

| 症状（弹窗/console 文本） | 最可能出错 | 首选排查 |
| --- | --- | --- |
| 按钮完全不显示（AI 和用户消息都没有） | Client 半根本没 apply：入口挂起/未激活 | 见「1」AI 按钮显示；插件 entry 状态；`exports.inject`；`globalThis.__dshMoreMessageActionsApplied` |
| 只有 AI 消息有按钮，用户消息没有（或反之） | 槽位 OK 但 DOM 注入选择器失效 / DOM 注入 OK 但槽注册失败 | 分别查「1」两行；检查内核聊天 UI 是否换了 DOM 标记 |
| 点击按钮无任何反应 | 事件没绑上（重复注入/React 重渲染删除了 DOM）/ overlay 未渲染 | console；检查 `.mma-user-actions` 是否被平台重渲染抹掉；MutationObserver 是否还在跑 |
| 操作失败：`session.events is not iterable` | Host 读事件方式过时（rc.1 应走 `snapshotEvents()`/`log`） | `lib/index.js` 的 `sessionEvents()`；`runInplace` 是否用它 |
| 操作失败：`无法读取会话事件日志（…）` | `sessionEvents()` 所有分支都没命中（引擎再改版） | 确认 Session 实例上当前的事件接口名 |
| 操作失败：`消息未找到` / `AI 消息未找到` | messageId 匹配不到事件：类型不匹配（user vs assistant）、旧日志无 id、DOM key≠messageId | `resolveTarget`；事件里 `data.id` vs `data.message.id`；必要时回退 seq |
| 操作失败：`该回合没有可重放的纯文本用户消息…` | 该回合用户消息含图片/非 text 块；或找的不是目标回合的用户消息 | `findTurnUserMessage` + `plainTextOf`；确认 content 块结构 |
| 操作失败：`缺少原用户消息`（edit-ai） | **v0.5.0 起不再出现**：edit-ai 改为只替换回复文本，不再需要找原用户消息 | 若仍出现说明运行的是旧 Host（需重启 `dsh web`） |
| 操作失败：`重试文本为空` | retry 流程的 userText 为 null | `findTurnUserMessage` |
| 操作失败：`请先停止当前回合…` | 会话在跑（正常拒绝）或 `agent.phase.kind` 误判 | 确认 agent.phase 语义 |
| 操作成功但内容没变 / 界面没刷新 | 落盘成功但内存与磁盘不一致 / resync 失败 | 看是否生成 `.inplace-*.bak`；`rewritePersisted`；Client `resyncSession` |
| 弹窗打开但 AI 回复没预填 | `useChat` 不可用或快照里找不到该 messageId 的 turn-tail | `assistantMessageTextInChat`；节点结构 |
| 保存后多删/少删了一整轮 | 使用的是 v1.0.0 单条删除之前的旧语义（截断到上一回合平衡点）；或 Retry/重试路径仍在截断 | 重启 `dsh web` 使 v1.0.0 Host 生效；重试类操作本来就是按回合截断的，属预期 |
| 删除后目标消息还在 / 其它消息被误删 / 残留半个过程块 | 删除逻辑仍走旧 `planDeleteSurvivors`/截断路径（旧 Host），或 `collectDeleteIndexes` 摘除集合算错（assistant 目标未覆盖整个 AI 侧 / 误带 user 或后续回合内容） | 重启 `dsh web`；核对 `collectDeleteIndexes`（AI 回复应覆盖所在回合全部 step/chunk/tool 行；user/steering 行、turn 边界与后续回合不得在内） |
| 删除中间消息后继续对话上下文怪异（如“有问无答”、相邻同角色） | 预期行为：删除只移除目标消息本身，对应的消息与后续消息都保留，模型上下文不再包含被删内容 | 无需修；确认弹窗文案已说明删除范围 |
| 删除后日志 seq 不连续 / 重放失败 / 会话打不开 | `rebaseEvent` 重编号或引用平移出错（sourceEventSeqs / surfaceOp replace start/end），或 coordinator.cursor 未同步 | 备份恢复 `.inplace-*.bak`；核对 `countDropsBelow` 平移公式与 `rewritePersisted` 的 `keepLen` |
| 编辑后思考链/工具调用消失 | 仍在使用旧 Host（edit-ai 走截断重建路径）或编辑的是整条带内容的消息 | 重启 `dsh web` 使 v0.5.0 Host 生效；检查 `swapAssistantMessageText` 是否只动了 text 块 |
| 重启后会话文件损坏 / 打不开 | 重写文件与后端起 append 游标不一致 | 备份恢复 `.inplace-*.bak`；检查 `encodeMaterialization` 头与 `coordinator.state.cursor` |
| 只在某次升级后坏 | 内核内部结构/接口改名（见 D 表） | 对照 D 表逐项核对 |

## 3. 两条渲染链路（按钮怎么来的）

**AI 消息（React / 槽位）**
- 平台对每条「已完成的 assistant 回合」渲染 `turn-tail` 节点，其行内图标栏调用
  `renderSlot('conversation.chat.assistant-actions', { messageId })`。
- Client 在 `apply()` 里注册：`ctx.slots.register({name:'conversation.chat.assistant-actions', id:'more-message-actions', order:20, locale:NS, inject:()=>({})}, AssistantActionsView)`。
- 组件从 props 拿 `messageId`（owner prop）、`sessionId`/`t`/`useChat`（session scope 标准 prop）。
- 平台在**运行中/未结束的回合不渲染该槽位** → 此类消息本来就没有按钮（不是 bug）。

**用户消息（纯 DOM 注入）**
- 内核聊天列表每个节点外包一层 flow item：`data-chat-flow-kind`(`user`/`steering`…)、`data-chat-flow-key`、`data-chat-turn`。
- `injectUserActions()` 找到这些节点 → 在其图标操作行（CSS Module 哈希类，形如 `xxxxxx_actions`，与复制按钮同行）插入 `.mma-user-actions`。
- 由 `MutationObserver` 在行被 React 重渲染/重建后重新注入；通过容器是否存在防重复。

## 4. 操作成功链路（改了之后会发生什么）

| op | Host 做的事 | 收尾 |
| --- | --- | --- |
| `delete`（用户消息） | resolveTarget → `collectDeleteIndexes`（仅该事件）→ `spliceOutEvents` 摘除 + 后续事件重编号 → 重写全量落盘 | 只删这条消息；其 AI 回复与后续内容全部保留 |
| `delete`（AI 回复） | `collectDeleteIndexes` 取其所在回合整个 AI 侧（step 行、思考过程消息与流式 chunk、tool/call + tool/result）→ `spliceOutEvents` → 重写全量落盘 | 回复连同思维链/思考过程/工具调用一并移除，无残留过程块；对应用户提问与后续内容保留 |
| `retry` | 截断到上一处 turn/end → 取该回合用户纯文本（可带 requirement）→ `agent.followup` | AI 重新回答 |
| `edit-user` mode=save | `swapUserMessageText`：只替换该用户消息的 text 块 → 重写全量落盘（**不截断**） | 旧回答与后续内容全部保留 |
| `edit-user` mode=retry | 截断 → `agent.followup(编辑后文本)` | AI 重新回答 |
| `edit-ai` | `swapAssistantMessageText`：只替换该回复的 text 块 → 重写全量落盘（**不截断**） | 思考链/工具调用与后续内容保留 |

## 5. 协议/数据契约（改接口前先看这里）

**RPC**：`POST /api/dsh-more-message-actions/inplace`
```jsonc
// 请求体（写操作）
{ "sessionId": "…", "op": "retry|edit-user|edit-ai|delete",
  "messageId": "…",   // assistant 取事件 data.message.id；user 取事件 data.id（rc.1）
  "seq": 0,           // 兼容后备（旧日志无 id 时）
  "text": "…", "requirement": "…", "mode": "save|retry" }
// 响应 200: {ok:true, op, truncatedTo?, removedEvents?, regenerating?}
//   delete 响应含 removedEvents（移除的事件行数）与 truncatedTo（删除后的 log 长度）
// 错误 400: {error:"人类可读原因"}

// 只读预填 RPC（v0.5.1，同一端点）
{ "sessionId": "…", "op": "text", "messageId": "…" | "seq": 0 }
// 响应 200: {ok:true, op:"text", text:"该消息持久化文本块的拼接（无则空串）"}
```
**事件形状（rc.1 日志）**
- `user/message`：`event.data` = 消息本体 `{id, role, content:[{type:'text'|…}], source}`（无嵌套 message）。
- `assistant/message`：`event.data = {turn, step, message:{id, role, content…}, [interrupted|usage]}`。
- 回合边界：`turn/start`、`step/start`、`step/end`、`turn/end`（`reason.kind`）。
- seq 连续契约：`seq === log 下标 === 持久化游标`；删除后需把后续事件整体重编号（`rebaseEvent` 的 `countDropsBelow` 平移），并同步平移 `sourceEventSeqs` 与 `surfaceOp`(replace) 的 start/end。

**槽位 props（rc.1）**
- assistant-actions：owner props `{messageId}`；session 标准 props 含 `sessionId`、`t`(locale NS)、`useSession`、`useChat` 等。
- register 选项：`name`（槽名）、`id`（唯一 cell）、`order`（升序）、`locale`、可选 `inject(sessionId)=>props`。

## 6. 内核接口依赖清单（最易被升级打破，重点速查）

| 依赖点 | 用途 | 当前内核位置（0.1.2-rc.1） | 若升级后坏了先核对 |
| --- | --- | --- | --- |
| `ctx.sessions.get(id)` / `flush(session)` | 取实时 Session / 冲刷待写 | `@deepseek-ai/dsh-session`（SessionStore, service "sessions"） | 方法名/入参 |
| Session `.log`（数组）/ `.snapshotEvents()` | 读全量事件 | `dsh-session`（Session 类） | `.events` 已删；勿回退 |
| Session `.append(type, data, {surfaceOp, sourceEventSeqs})` | 追加合成回合 | `dsh-session`（Session.append） | 返回值含 `seq`；surface 校验规则 |
| Session `.surfaceManager` `{log,baseSeq,_state,_lastProcessedSeq,_pendingPlan}` | 截断后重置 surface 折叠 | `dsh-session`（SurfaceManager；`createFoldState()` = `{nodes:[], replaceGeneration:0}`） | 字段名/_state 形状 |
| Session `.eventsSnapshot/.headerFold/.contextFold/.derived*` | 截断后清缓存 | `dsh-session`（Session） | 字段是否仍存在 |
| `ctx.sessionPersistence.locate(meta)`、`encodeMaterialization({meta,inheritedEventCount}, events)` | 定位并重写文件 | `@deepseek-ai/dsh-session-persistence-jsonl` | **签名已从 (header,events) 改为 storage 描述符** |
| `backend.coordinator.states.get(id).{cursor,materialized}`、`preparations.invalidate(id)` | 重置追加游标 | `@deepseek-ai/dsh-session-persistence`（PersistenceCoordinator） | state 字段结构 |
| `ctx.agents.get(id)`、`agent.phase.kind`、`agent.followup(msg)`、`agent.inbox.clear()` | 触发重试/置空闲 | `@deepseek-ai/dsh-agent`（AgentRegistry）、`dsh-agent-loop` | agent 是否按 sessionId 索引；phase 结构 |
| `binding.session.getSnapshot().running` / `resync()` | Client 侧运行态 + 刷新 | client `dsh-api-session-controller`（Session.buildSnapshot） | snapshot 字段名；resync 是否存在 |
| 槽 `conversation.chat.assistant-actions`（kind list, scope session） | AI 按钮 | client `dsh-client-ui-chat`（TurnTailNodeView 渲染）、`dsh-client-ui-slots` | 槽名/owner props（messageId） |
| 聊天 DOM：`data-chat-flow-kind/key/turn`、`*_actions` 图标行、turn-tail `closing.finalNode.messageId`/`closing.blocks` | 用户按钮定位 + AI 预填 | client `dsh-client-ui-chat` | DOM 标记/节点结构（UI 重写重灾区） |
| 平台 seed：`react/react-dom/@deepseek-ai/dsh-client-ui-primitives` | Client require | 前端 shell（`__DSH_BOOT__` staticModules） | seed 表变化会影响 require |

## 7. 验证与恢复要点

- **改动生效**：Host 半改动 = 重启 `dsh web`（只刷新页面无效）；Client 半改动 = 刷新页面即可；开发态可用 `pnpm run dev:web`（client HMR）即时热更 Client。
- **每次操作前自动备份**：`<会话>.jsonl.inplace-<时间戳>.bak`（与日志同目录）。怀疑损坏先找它恢复。
- **失败自动回滚**：任何一步失败（含重放/落盘后失败）→ `rollbackSession` 同时恢复内存 log 与磁盘文件到操作前状态；回滚写入也失败时用 `.inplace-*.bak` 手动恢复。
- **本地快速验证脚本**：`node --check lib/client.js && node --check lib/index.js`（两个半部语法）。
- **加日志**：Client 注入路径的 `console.error` 前缀均为 `[dsh-more-message-actions] …`；Host 的错误会原样回到弹窗「操作失败：…」。

## 8. 历史踩坑记录（前车之鉴）

| 版本 | 内核 | Bug | 根因 | 修法 |
| --- | --- | --- | --- | --- |
| ≤0.3.1 | 旧 rc | 按钮不显示 | 内核重写聊天 UI：Session 快照字段(`chat.nodes/turnEnds`…)删除、DOM 去掉 `data-time-hover-root`、旧 client 模块名(`dsh-client-runtime`…)消失 | v0.4.0 重写 Client：assistant 走官方槽位拿 messageId、user 走新 DOM 图标行注入；删折叠功能；package.json 去掉死 inject |
| 0.4.0 | rc.1 | 操作报错 `session.events is not iterable` | Host 读取事件用旧 `.events`；rc.1 改为 `log`/`snapshotEvents()`；`encodeMaterialization` 签名也变了 | v0.4.1：`sessionEvents()` 兼容读取 + 落盘传 `{meta, inheritedEventCount}` |
| 0.4.x | rc.1 | **消息操作（如编辑）后思考内容/思考链/工具调用丢失** | edit-ai / edit-user(save) 把整回合截断后重建为纯文本合成回合，reasoning 块与工具过程被丢弃；delete 整回合移除，误删回复之前的提问与思考/工具步骤；后续内容一律被截断 | v0.5.0：编辑改为只替换目标消息的 text 块（`swapAssistantMessageText`/`swapUserMessageText`，不截断）；delete 改为最小化（`planDeleteSurvivors`+`appendSurvivorTurn` 重建回合保留回复之前内容）；失败路径回滚磁盘文件 |
| 0.5.0 | rc.1 | 编辑用户消息弹窗预填与 AI 不一致/不可靠（此前靠 DOM 抓气泡文本，富内容或重渲染后易错/为空） | 客户端在 DOM 注入路径没有数据层文本来源 | v0.5.1：Host 增加只读 `op:'text'`（`peekMessageText`，日志原文），Client `openUserEditDialog` 先取持久化原文再开弹窗；DOM 文本仅回退 |
| 0.5.1 | rc.1 | **用户消息全部操作报“消息未找到”**（预填失败回退空框、编辑/删除失败） | `data-chat-flow-key` 是会话引擎合成 key（`conversationContextKey` = `${kind.length}:${kind}${id}`，用户行即 `13:input-message<uuid>`），并非持久化消息 id；v0.4.0 起就按 key 当 messageId 发给了 Host | v0.5.2：Client 新增 `durableIdOfDomKey()` 剥掉前缀再调用 Host；预填/编辑/删除恢复可用 |
| 1.0.0 | rc.1 | **删除会“波及”太多内容**：删除任一消息都会截掉它之后整段对话（即使只是删一条误发/想移除的消息），删 AI 回复要重建回合、删用户消息会连 AI 回复一起没；且删 AI 回复后界面残留无回复的思考/工具过程块 | 删除沿用「截断到上一已完成回合 + 幸存内容重放」的旧语义（`planDeleteSurvivors` + `appendSurvivorTurn`），本质是“从这里重写会话”，不是“删这一条” | v1.0.0 定型：删除改为单条摘除（`collectDeleteIndexes` + `spliceOutEvents`）——user/steering 只摘除其单事件；assistant/message 摘除其所在回合**整个 AI 侧**（step 行、思考过程消息与流式 chunk、tool/call + tool/result），避免残留过程块；后续事件重编号保持 seq 连续后全量重写落盘；不截断、不重建回合，对应消息与后续消息不受影响 |
