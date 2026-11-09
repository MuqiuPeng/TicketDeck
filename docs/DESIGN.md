# TicketDeck 设计方案

> 状态：草案 · 2026-11-09
> 一句话：在 vibecoding 时，让模型自己开 ticket、认领 ticket、更新进度，人在一块看板上看全局，并且一键跳回处理该 ticket 的 Claude 会话。

## 1. 要解决的问题

用 Claude Code 做 vibecoding 时有三个反复出现的痛点：

1. **发现的问题会丢。** 模型干活时常会看到“这个以后要修”的东西，但它只存在于某一次会话的聊天记录里，会话一结束就没人记得了。
2. **跨会话没有全局视图。** 同一个项目往往同时开着好几个会话，哪个在做什么、做到哪了，只能一个个点进去看。
3. **任务和会话脱节。** 即使记下了待办，也找不到当初是哪个会话在处理它、上下文在哪。

Claude Code 自带的任务列表只在一次会话（一个 turn）内有效，解决不了上面三点。

## 2. 目标与非目标

**目标**
- 模型可以通过 MCP 工具**自动**创建、认领、更新、关闭 ticket，无需人工录入。
- ticket 存放在项目仓库里（纯文本、可 diff、随 git 走），没有任何服务端也能用。
- 一个看板窗口：跨项目查看所有 ticket，实时刷新。
- ticket ↔ Claude 会话双向关联；配合 TabStack 可以一键切到对应工作区和会话。
- macOS 和 Windows 都能用（TabStack 正在做 Windows 版）。

**非目标（v1 不做）**
- 多人协作、权限、云同步。
- 与 GitHub Issues / Linear 双向同步（以后可以做单向导出）。
- 时间估算、燃尽图之类的项目管理功能。

## 3. 为什么独立于 TabStack

- TabStack 的职责是窗口和工作区，ticket 属于“内容管理”，放进去会让它失焦。
- 侧边栏只有一列图标，放不下看板；看板总得是一个独立窗口，那它作为 TabStack 的一个 tab 就够了。
- 数据放在仓库里，TabStack 没运行时模型也能正常使用。
- 看板用 Web 实现，Mac 和 Windows 只写一次；如果放进 TabStack，就要用 Swift 和 C# 各写一遍。

TabStack 只做很薄的一层对接（见第 8 节）。

## 4. 总体架构

```
┌────────────── Claude Code 会话 (多个) ──────────────┐
│  CLAUDE.md 规则 → 调用 MCP 工具 ticket_*            │
└───────────────┬─────────────────────────────────────┘
                │ stdio
        ┌───────▼────────┐        ┌──────────────────────┐
        │ ticketdeck-mcp │        │ ticketdeck serve     │
        │                │        │ (本地 HTTP + SSE)    │◄── 浏览器看板
        └───────┬────────┘        └──────────┬───────────┘    (TabStack 中的一个 tab)
                │      共用 core 库          │
                └──────────┬─────────────────┘
                           ▼
            <repo>/.tickets/T-0007-xxx.md  (单一事实来源)
            ~/.ticketdeck/projects.json   (项目注册表)
                           ▲
                           │ 只读：统计数量
                       TabStack (角标 / 深链)
```

**技术选型：** 一个 TypeScript / Node 包，包含 `core`、`cli`、`mcp`、`server`、`web` 五个部分。
- 选 Node 的原因：MCP 官方 SDK 成熟；跨平台；看板和后端用同一种语言。
- 看板前端用 Vite + 一个轻量框架（Preact 或 Svelte），构建产物由 `ticketdeck serve` 托管。

## 5. 数据模型

### 5.1 存储布局

```
<repo>/.tickets/
  T-0001-login-redirect-loop.md
  T-0002-extract-auth-middleware.md
  archive/                 # 已完成或已放弃超过 N 天的 ticket，自动移入
  config.json              # 可选：前缀、状态列、自动归档天数
```

- 每个 ticket 一个 markdown 文件，文件名为 `<ID>-<slug>.md`。
- ID 按项目递增（`T-0001`）。分配新 ID 时扫描当前最大值，再用 `O_EXCL` 创建文件，冲突就 +1 重试，避免多个会话同时开 ticket 时撞号。
- 是否提交到 git 由用户决定，默认建议提交。

### 5.2 文件格式

```markdown
---
id: T-0007
title: 登录后重定向死循环
status: doing          # todo | doing | review | done | dropped
priority: P1           # P0..P3
type: bug              # bug | feature | chore | idea
labels: [auth]
created: 2026-11-09T10:12:00+08:00
updated: 2026-11-09T11:40:00+08:00
created_by: local_26ded1a5-…   # 会话 id，人工创建时为 "user"
session: local_9d1be7dc-…      # 当前认领的会话，可空
depends_on: [T-0004]
files: [src/auth/redirect.ts]
---

## 背景
发现于实现 T-0004 时：……

## 验收标准
- [ ] 未登录访问 /dashboard 只重定向一次
- [ ] 补充 e2e 用例

## 日志
- 2026-11-09 11:40 · local_9d1b… · 定位到 middleware 顺序问题，正在修
```

**约定：**
- frontmatter 是给机器读的；正文是给人和模型读的。
- “日志”一节只追加不改写，由 `ticket_log` 工具写入。
- 状态流转：`todo → doing → review → done`，任何状态都可以转为 `dropped`。**模型最多只能把 ticket 推到 `review`，`done` 必须由人确认**（在看板上点，或者对模型说“关掉 T-0007”）。

### 5.3 项目注册表

`~/.ticketdeck/projects.json` 记录所有用过 TicketDeck 的项目路径和最后活跃时间。MCP 第一次在某个 cwd 下被调用时自动注册，看板据此做跨项目视图。

## 6. MCP 工具（给模型用）

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `ticket_list` | 列出当前项目的 ticket | `status?` `label?` `mine?`（只看本会话认领的） |
| `ticket_get` | 读取一个 ticket 的全文 | `id` |
| `ticket_create` | 新建 ticket | `title` `type` `priority` `body` `labels?` `depends_on?` `files?` |
| `ticket_update` | 修改字段或状态 | `id` + 要改的字段（`status` 不接受 `done`） |
| `ticket_claim` | 认领：设为 `doing` 并写入 `session` | `id` |
| `ticket_log` | 在日志中追加一条进展 | `id` `note` |

**设计要点**
- **防重复：** `ticket_create` 会先按标题和涉及文件做相似度检查。若发现疑似重复，返回候选列表，不创建；模型确认后带上 `force: true` 再提交。
- **会话 id：** MCP 服务需要知道调用方是哪个会话。优先读取 Claude Code 提供的会话信息（**待验证**：环境变量或 MCP 握手中是否带有 session id）。拿不到时退而记录 `cwd + 时间戳`，由看板或 TabStack 按 cwd 加最近活跃时间反查（TabStack 的 `ClaudeSessions` 已实现这套逻辑）。
- **返回内容简洁：** `ticket_list` 只返回 id、标题、状态、优先级，避免占用模型上下文。

## 7. 模型行为规则（CLAUDE.md 片段）

工具只决定“能不能”，规则决定模型“会不会”主动用。`ticketdeck init` 会把下面这段写进项目的 CLAUDE.md：

```markdown
## Tickets (TicketDeck)
- 开始工作前先 `ticket_list status=todo,doing`，看看有没有相关 ticket；有就 `ticket_claim`。
- 发现超出当前任务范围、但值得之后处理的问题时，用 `ticket_create` 记下，不要顺手修。
- 用户说“以后再做 / 先记一下”时，开 ticket。
- 计划超过 3 个独立步骤时，可以拆成多个 ticket，并用 depends_on 串起来。
- 完成一个里程碑时用 `ticket_log` 记一句；做完后把状态设为 `review`，不要设为 `done`。
- 不要为一两分钟就能做完的小事开 ticket。
```

## 8. 看板（给人用）

`ticketdeck serve` 在 `localhost:4477` 启动服务，用浏览器打开，作为 TabStack 工作区里的一个 tab。

- **看板视图：** 按状态分列（todo / doing / review / done），可拖拽改状态；顶部按项目、标签、类型筛选；也有“全部项目”视图。
- **详情面板：** 渲染 markdown，可勾选验收项；显示认领会话和依赖关系。
- **操作按钮：**
  - **打开会话：** `claude://code/continue?session=…`
  - **在 VS Code 打开：** `vscode://file/<repo>/<file>`
  - **在 TabStack 中打开：** 见第 9 节
- **实时刷新：** 服务端用 `fs.watch` 监听各项目的 `.tickets/`，通过 SSE 推送变化；模型一改文件，看板马上更新。
- **review 提醒：** 有 ticket 进入 `review` 时发系统通知（可关闭）。

## 9. TabStack 对接（薄层，最后做）

全部是可选功能。TabStack 只读取 ticket，不写入。

1. **工作区角标：** TabStack 已能通过 `ClaudeSessions.folders(of:)` 知道每个工作区对应的项目文件夹，据此统计各文件夹下 `.tickets/` 中 `doing` 和 `review` 状态的数量，显示在工作区图标上。现有的 `badge(for:)` 是按应用的 Dock 角标，这里需要新增一种“工作区角标”。
2. **深链：** 新增 URL scheme `tabstack://open?folder=<path>&session=<local_…>`，切到包含该文件夹的工作区，并把其中的 Claude tab 切到指定会话（复用 `update_workspace.claudeSession` 的逻辑）。看板上的“在 TabStack 中打开”按钮就调用它。
3. **工作区模板：** `open_window` 时可以顺带把看板加成一个 tab（`app: chrome, urls: [http://localhost:4477/?project=…]`）。

Windows 版 TabStack 将来实现同样的 1、2 两点即可，看板本身不用改。

## 10. 里程碑

| 阶段 | 内容 | 完成标准 |
|---|---|---|
| **M1 核心** | core 库、CLI（`init/list/new/show/set`）、MCP 服务、CLAUDE.md 规则 | 在一个真实项目里，模型能自动开、认领、记录 ticket；人用 `ticketdeck list` 能看到 |
| **M2 看板** | `serve` + Web 看板 + SSE + 跨项目视图 | 模型改动后看板 1 秒内刷新；能在看板上把 ticket 改为 done |
| **M3 会话关联** | 确认获取会话 id 的方式；看板的“打开会话”按钮 | 点一下就能回到当初处理该 ticket 的会话 |
| **M4 TabStack** | 工作区角标 + `tabstack://` 深链 | 从看板一键切到对应工作区和会话 |
| **M5 打磨** | 自动归档、review 通知、导出到 GitHub Issues | 按需 |

建议先做 M1，在 TabStack 项目上用一周，根据模型实际开 ticket 的频率和质量调整第 7 节的规则，再做 M2。

## 11. 风险与待定问题

- **模型开 ticket 太多或太少。** 这是最大的不确定因素，只能靠规则和防重复检查迭代调整。可以在看板上统计每个会话开了多少 ticket、其中多少被 dropped，作为调参依据。
- **会话 id 能否可靠获取。** 需要在 M3 之前验证，回退方案见第 6 节。
- **git 冲突。** 每个 ticket 一个文件，冲突概率低；ID 冲突靠 `O_EXCL` 解决。跨分支开出同号 ticket 的情况，由 `ticketdeck doctor` 检测并重新编号。
- **待定：** 是否默认把 `.tickets/` 加入 `.gitignore`；看板端口是否固定。

## 12. 考虑过的其他方案

- **直接用 GitHub Issues + `gh`：** 需要联网和远程仓库，速度慢，也没法和本地会话、窗口联动。适合将来作为导出目标。
- **Linear 等 SaaS：** 同样的问题，而且对个人 vibecoding 来说太重。
- **做进 TabStack 内部：** 理由见第 3 节。
