# dsh-more-message-actions

[![version](https://img.shields.io/badge/version-1.0.0-blue)](./package.json)
[![license](https://img.shields.io/badge/license-MIT-brightgreen)](./LICENSE)
[![platform](https://img.shields.io/badge/platform-DSH%20Web%200.1.2--rc.1-lightgrey)]()

> 本插件旨在还原 DeepSeek 网页端与主流 AI 客户端习以为常的对话操作，如**消息编辑、重试与删除**，让 DeepSeek Harness 里的对话同样顺手。

---

## 功能

> 该插件实现的消息操作均**不创建分叉**；「删除」只移除目标消息本身——删除 **AI 回复**会连同它的思维链 / 思考过程 / 工具调用一并移除，但不删除它对应的用户提问；删除 **用户消息**不删除它的 AI 回复；两者都不影响后续任何消息。

| 按钮 | 用户消息 | AI 消息 | 说明 |
| :--- | :---: | :---: | --- |
| **编辑** | ✅ | ✅ | 弹出编辑框修改消息文本 |
| **修改并重试** | ✅ | — | 以修改后的用户文本重新发起请求 |
| **重试** | — | ✅ | 以**原用户消息**重新生成 |
| **高级重试** | — | ✅ | 先输入对 AI 回复的要求，再原地截断并按「原消息 + 要求」重新生成 |
| **删除** | ✅ | ✅ | 删除对应消息 |

---

## 安装

> 本插件暂时仅通过GitHub 分发，未发布到 npm

### 方式一：从 GitHub 直接安装

```bash
dsh plugin --profile web add git+https://github.com/suzuran520yyz/dsh-more-message-actions.git
```

### 方式二：克隆到本地后安装

```bash
git clone https://github.com/suzuran520yyz/dsh-more-message-actions.git
cd dsh-more-message-actions
dsh plugin --profile web add link:.
```

> 安装后**重启 dsh web**，并刷新已打开的页面即可生效。

---

## 工作原理

本插件是一个「双面」插件，由 Host 半与浏览器半协作完成：

| 部分 | 职责 |
| --- | --- |
| **Host 半**（`lib/index.js`） | 执行原地会话手术：改写持久化日志（编辑/删除为单点改写，重试类为回合截断）、重置协调器游标、触发 Agent 重放；提供只读 RPC 供预填原文。 |
| **浏览器半**（`lib/client.js`） | 向消息操作栏注入图标按钮、调用 Host 接口并重新同步历史窗口；负责用户消息 DOM key → 持久化 id 的换算。 |

---

## 限制与风险

> 原地改写深入 DSH 引擎内部（`session.log`、`surfaceManager._state`、`agent.phase`、`coordinator.states`），虽已做备份与回滚，仍建议在重要会话操作前留意备份文件。

- **只能在会话空闲时操作**：回合正在运行时 Host 会拒绝（请先停止）。
- **重试 / 高级重试 / 修改并重试只支持纯文本回合开头**：含图片附件的回合无法安全重放；而「编辑（保存）」仅替换消息文本块，其余内容块（含附件）会保留。
- **删除只移除目标消息本身**：删除 AI 回复会连同该回合的思维链 / 思考过程 / 工具调用一并移除（不留悬空过程块），但它对应的用户提问保留；删除用户消息只移除该消息，其 AI 回复保留。若删除的是会话中间的消息，之后继续对话时模型请求中不再包含被删内容，可能出现「有问无答」或相邻同角色消息的情况，属预期行为，请自行斟酌。
- 原地重试会**替换**旧回复，不再提供 fork 版的前后翻页切换。
- 「编辑（保存）」只改文本、保留旧的 AI 回答时，旧回答可能与新文本不一致，需自行判断；想让 AI 按新文本重新回答，请使用「修改并重试」。
- 依赖当前 DSH rc 版本的内部结构；引擎升级后可能需要同步更新。

---

## 开发

```bash
node --check lib/client.js
node --check lib/index.js
```

新增功能与故障排查请先查阅 **[BUG-CHECKLIST.md](./BUG-CHECKLIST.md)**。

---

## 更新日志

### v1.0.0

- 首个公开发布版本，可能会有迷之BUG

---

## 免责声明

> 本仓库中的全部代码、配置与文档均由模型生成

- 代码按 **“现状”（AS-IS）** 提供，**不附带任何明示或暗示的保证**，包括但不限于适销性、特定用途适用性与不侵权保证；
- 作者 / 维护者**不对任何直接、间接、偶然或后果性损害负责**，包括因使用本插件导致的数据丢失或会话异常；
- 请在使用前**自行审查代码并做好备份**，仅在充分理解其行为的前提下用于重要数据；
- 本项目是 **DSH 的第三方社区插件**，与 DeepSeek / DSH 官方**无任何隶属或背书关系**，官方不提供任何支持与维护承诺；
- 项目名称中出现的 “DSH”“DeepSeek Harness” 等仅为平台指代，相关商标与名称归其各自所有者所有。

---

## 开源协议

[![license](https://img.shields.io/badge/license-MIT-brightgreen)](./LICENSE)

本项目基于 **MIT License** 开源，完整文本见 **[LICENSE](./LICENSE)**
