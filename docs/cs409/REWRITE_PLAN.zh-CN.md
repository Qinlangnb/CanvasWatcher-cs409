# CanvasWatcher-cs409 重写方案

本仓库从 [CanvasWatcher](https://github.com/Qinlangnb/CanvasWatcher) `aca5813` 分出，用于 CS409 课程项目。上游仍是个人部署版本（Python 后端，多用户网关）；本 fork 的核心变化是**后端改为 JavaScript（Node.js）**，并按课程要求补齐团队分工、启发式评估与设计重点。

## 1. 课程要求对照

| 课程要求 | 本方案的做法 |
| --- | --- |
| 3–5 人团队，每人有明确角色 | 见第 8 节角色表；每个角色对应仓库中的负责目录和交付物 |
| 前端 + API + JavaScript 后端 + 至少一个数据库 | 复用现有 React 前端；新写 Node.js REST API；PostgreSQL |
| 用户认证 | 后端自带注册/登录/登出/改密，服务端 session + CSRF，argon2id 哈希 |
| 启发式评估，至少一次修订 | 第 4–5 周两轮评估（Nielsen 10 条），修订前后截图与问题表放 `docs/cs409/heuristic-evaluation.md` |
| 重点在 UX、UI、响应式 | 统一设计系统、真正的前端路由、统一断点、WCAG 2.2 AA、空状态/加载/错误恢复/首次引导 |

## 2. 现状盘点（`aca5813`）

| 部分 | 技术 | 规模 |
| --- | --- | --- |
| `backend/app` | Python · FastAPI · SQLAlchemy · SQLite · APScheduler | 约 17,100 行；35 张表；113 个路由；387 个 pytest 用例 |
| `frontend/src` | React 18 · TypeScript · Vite · react-query · FullCalendar · zod | 约 6,900 行；实际调用 69 个不同的 API 路径 |
| `identity-gateway` | Python · FastAPI（登录、邀请、反代到每用户后端进程） | 约 2,200 行 |
| `auth-broker` | Python · Playwright（Windows 本机登录学校 SSO 取 cookie） | 约 1,500 行 |
| `ops` | 每用户一个后端进程、Unix socket、5 个槽位、systemd | 约 1,000 行 |

**关键观察**：现在的“多用户”是“网关 + 每个用户一个完整后端进程”。这对个人服务器的隔离很有用，但对课程项目过重：部署复杂、无法横向扩展、每个用户常驻一个进程。重写时改成**单个 Node API + 每行带 `user_id` 的数据隔离**，网关、槽位、provisioner 全部不需要。

## 3. 技术选型

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | Node.js 22 LTS | 课程要求 JavaScript 后端 |
| 语言 | **TypeScript**（编译为 JS 运行），备选：纯 JS + JSDoc + `// @ts-check` | 前端已是 TS，可与前端共享类型；若课程认定只接受纯 JS，改用备选，结构不变 |
| Web 框架 | Express 5 | CS409 课上用 Express，组员上手成本最低 |
| 校验与契约 | zod（`shared/` 包前后端共用）+ zod-to-openapi 生成 OpenAPI，`/api/docs` 提供 Swagger UI | 前端已经在用 zod；REST 接口有可读文档，方便评分和协作 |
| 数据库 | PostgreSQL 16（本地用 docker compose） | 现有模型是关系型（35 张表、大量外键）；Mongo 需要重新设计文档结构，收益不大 |
| ORM / 迁移 | Prisma | schema 文件可读、迁移工具成熟，适合多人协作 |
| 后台任务 | 数据库租约 + 进程内定时器（第 2 周起；原计划 pg-boss） | `canvas_connections.sync_lease_until` 保证同一用户不并发、可跨进程；定时器每分钟挑出到期的连接。规模只有一个 API 进程，不值得再引入队列服务 |
| 认证 | 自写 session：随机 token（库里只存哈希）、`httpOnly; Secure; SameSite=Lax` cookie、`X-AW-CSRF` 双提交（前端已实现）、`@node-rs/argon2`、登录限速 | 直接移植现有网关的设计，已在线上验证过 |
| 凭据加密 | node:crypto AES-256-GCM，主密钥来自环境变量 | 用户的 Canvas token 不以明文入库 |
| 外部请求 | 原生 `fetch`（undici）+ p-retry + p-limit | 统一一个 HTTP 客户端，带超时、重试和并发上限 |
| 日志 / 测试 / CI | pino · vitest + supertest · Playwright E2E · GitHub Actions | |

## 4. 范围裁剪

113 个路由不可能在课程周期内全部移植，按“前端实际调用 + 课程演示价值”裁剪：

- **MVP（必须完成）**：注册/登录/账号；首次引导连接 Canvas（个人 access token）；课程与学期；任务（截止时间、进度、完成、忽略）；文件列表与按需下载；变动动态（已读/未读）；Today 计划；Timeline；日历（ICS 导入 + 可用时间）；通知；通用设置。
- **加分项（有时间再做）**：AI 聊天、Google 日历同步、网站来源、变动过滤规则、任务计时。
- **不移植**：Auth Broker（依赖 Windows + Playwright 模拟学校 SSO，部署和合规风险都高）、NTLM 网站源、Gradescope HTML 抓取、PHYS225 专用解析、多用户网关/槽位/provisioner、预览账号（改为种子数据的演示用户）。

## 5. 目录结构

```
CanvasWatcher-cs409/
├─ frontend/            现有 React 前端，逐步重构（见第 7 节）
├─ server/              新 Node API
│  ├─ src/
│  │  ├─ app.ts         Express 装配：helmet、Origin 检查、session、CSRF、错误处理
│  │  ├─ auth/          注册、登录、session、密码、登录限速
│  │  ├─ routes/        按资源拆分：users、sessions、canvas、sync、courses、tasks、files、changes
│  │  ├─ canvas/        Canvas API 客户端、主机白名单、字段归一化
│  │  ├─ sync/          同步服务（快照比对、变动事件）与定时器
│  │  ├─ security/      SecretBox：AES-256-GCM 加密 Canvas token
│  │  └─ http/          统一错误体与参数解析
│  ├─ prisma/schema.prisma
│  └─ tests/            Vitest + Supertest，用假的 Canvas 服务器，不连真实 Canvas
├─ legacy/              Python 后端、网关、broker，仅作移植对照；提交课程前删除
├─ docs/cs409/          本方案、启发式评估、角色分工、API 说明
└─ docker-compose.yml   postgres + server + frontend
```

## 6. 移植方法

1. **契约优先**：从现有 FastAPI 导出 `openapi.json`，以前端实际调用的 69 个路径为必移植集合，写成 `shared/` 中的 zod schema。新后端的每个响应都用同一份 schema 校验，前端代码基本不用改。
2. **行为规格从测试来**：387 个 pytest 用例里，把 today 排序、截止时间时区、变动检测、文件分类等核心用例翻译成 vitest，作为移植正确性的标准。
3. **数据模型精简**：35 张表合并为约 20 张，所有用户数据表加 `user_id` 外键与索引；仓储层的查询函数必须带 `userId` 参数，路由层拿不到不带用户限定的查询。

   | 旧表 | 新表 |
   | --- | --- |
   | （网关）users、sessions、invitations、login_attempts | `users`、`sessions`、`login_attempts` |
   | source_connections、credential_profiles、course_sources | `source_connections`（加密 token）、`course_sources` |
   | courses、course_policies | `courses`、`course_settings` |
   | tasks、deadlines、task_progress、task_source_links、task_work_sessions | `tasks`、`task_progress`、`work_sessions` |
   | source_items、source_snapshots、change_events | `source_items`、`snapshots`、`change_events` |
   | downloaded_files、pending_resources | `files` |
   | calendar_events、ics_calendar_import_sources、study_availability_* | `calendar_events`、`ics_sources`、`availability_rules`、`availability_overrides` |
   | plans、plan_blocks | `plans`、`plan_blocks` |
   | notifications、app_settings | `notifications`、`user_settings` |
   | ai_*、chat_*、analysis_jobs、change_analyses、google_*、change_filter_* | 加分项再建 |

4. **同步流水线**（第 2 周已实现）：定时器每分钟挑出超过 `SYNC_INTERVAL_MINUTES`（默认 30）未同步的连接，手动同步走 `POST /api/sync`（202 + 轮询）→ 先抢租约，同一用户同时只有一个同步 → Canvas 分页拉取课程、作业、文件、公告（每用户最多 3 门课并发）→ 每个条目算内容哈希，与上次快照比对 → 写变动事件；新加入的课程只记基线，不报变动 → 文件只存元数据，下载时向 Canvas 取新的临时链接并 302 跳转。Canvas 返回 401（或保存的 token 已无法解密）时标记连接需要重连，停止自动同步。

## 7. 现有代码中的低效部分与重构

审查覆盖 `backend/app`、`identity-gateway`、`frontend/src`。行号以 `aca5813` 为准。

### 7.1 上游也应修的问题（影响线上版本）

| # | 问题 | 位置 | 修法 |
| --- | --- | --- | --- |
| 1 | **正确性 bug**：每次同步把 `TaskAnalysis.analysis_json` 覆盖成 `deterministic_fallback`，Today 随即把 AI 估时当成旧数据丢弃、显示 FAILED，且因输入哈希未变不会重新排队 | `services/task_engine.py:218`、`services/today.py:263-281`、`ai/queue.py:65` | 确定性优先级因子与 AI 结果分字段存 |
| 2 | 每 2 分钟全量同步，不做增量；ETag/Last-Modified 存了但从不回传；网站源每轮重下所有 PDF | `scheduler.py:39`、`sources/canvas.py:200`（`del since`）、`sources/website.py:196-250` | 15–30 分钟一轮 + 手动触发；条件 GET；按主机限并发 |
| 3 | 同步循环逐条目多次查询并单独 commit；`source_items`、`pending_resources` 缺复合唯一索引 | `services/sync.py:458-527`、`task_engine.py:66-234` | 每个来源预载 `external_id → hash` 映射，跳过未变条目，一个来源一个事务，补唯一索引 |
| 4 | 变动是否展示在每次读取时重算（逐条加载新旧快照），`/changes` 无 SQL LIMIT，前端还每 30 秒轮询两次 | `api/routes.py:612-696`、`services/change_policy.py:176` | 写入时存 `visible` 标记，加 `(visible, read_at, detected_at)` 索引，计数与分页下推到 SQL |
| 5 | 已废弃的 Planner 每轮同步都插入新 Plan/PlanBlock 且从不删除；前端根本不调用 `/plan/today` | `services/sync.py:624`、`services/planner.py:52-108` | 删除 Planner 与两张表，只保留一个优先级函数 |
| 6 | GET 接口写库（`/courses`、`/courses/terms`、`/auth/profiles` 等每次读取都归一化并 commit） | `api/routes.py:173-235`、`services/auth.py:54-114` | 写入时归一化，GET 只读 |
| 7 | 手动同步与定时同步可并发，共用全局 `sync_state`；SQLite 未开 WAL/busy_timeout；同步在 HTTP 请求内跑完 | `scheduler.py:16-21`、`services/sync.py:77`、`db.py:619` | 单 worker + 互斥锁，`/sync/run` 返回 202 + 任务 id |
| 8 | 网关每个请求新建 httpx 客户端（新 SSL 上下文、无 keep-alive），每次重读 token 文件、开两次 sqlite 连接；argon2 在事件循环上跑 | `identity-gateway/aw_gateway/proxy.py:84,111`、`main.py:212,522-527` | 每槽位一个长连接客户端；会话与预览标记一次 JOIN 查出；哈希放线程池 |
| 9 | 前端全局 60 秒轮询所有查询、无 `staleTime`；根组件挂 14 个查询；同步后无差别 `invalidateQueries()` | `frontend/src/main.tsx:18`、`App.tsx:135-198` | 默认 `staleTime` 60 秒，只轮询 today 与未读数，查询下放到各视图，按 key 精确失效 |
| 10 | FullCalendar 经 SettingsView 静态导入进入主包（主包 642 KB / gzip 193 KB） | `App.tsx:8`、`SettingsView.tsx:14` | 懒加载 SettingsView 或 VisualCalendar |
| 11 | 计时卡片每 5 秒心跳 + 保存进度 + 全量刷新 today/tasks | `TodayView.tsx:251,307` | 心跳 30–60 秒，服务端按 `started_at` 推算，`pagehide` 时 `sendBeacon` 收尾 |
| 12 | 学术时区设置保存了却从未生效，前后端都硬编码 `America/Chicago` | `frontend/src/timezone.ts:1`；后端 32 处 `UIUC_TZ` | 统一读用户设置 |

### 7.2 重写时不要照搬的设计

- **巨型文件**：`routes.py` 1,860 行约 90 个端点、`sync.run` 单方法约 230 行、`App.tsx` 10 个组件、`SettingsView.tsx` 16 个组件。Node 版按资源拆路由，业务进 service 层。
- **REST 与 AI 工具各写一套变更逻辑**（`services/ai_chat.py:655-698` 与 `routes.py:238-282` 行为已不一致）。Node 版两者都调用同一 service。
- **来源配置分散在三处**（`courses.yaml`、`CourseSource.config_json`、`SourceConnection.config_json`），读取时再合并；适配器靠 `isinstance` 分支。Node 版：一张 `sources` 表 + 统一适配器接口（返回条目、健康状态、错误）。
- **HTTP 客户端散落各处、从不复用连接**（`canvas_client.py:167` 每次调用一次 TLS 握手）。Node 版：每个上游一个带连接池的客户端 + 全局限流。
- **查询依赖的字段藏在 JSON 里**（`metadata_json.auth_mode`、`config_json.baseline_complete`），快照永久保留全文。Node 版用显式列，快照设保留期。
- **迁移不可重放**：`0001_initial.py` 直接 `create_all` 当前模型。Node 版从全新的 Prisma 基线迁移开始。
- **课程专用代码混进通用流水线**（PHYS225 解析、`homework:N` 键会把 “HW1 Written” 和 “HW1 Code” 合成一个任务）以及 1,162 行的过期副本 `backend/hotfix_sync.py`。全部不移植。

### 7.3 前端重构（在 fork 中做，评估前完成）

- 引入 React Router（懒加载路由），取代 `App.tsx:47-129` 的手写路径解析；课程子页、设置子页进 URL。
- 拆功能目录：`features/{today,courses,files,changes,calendar,settings}`；共享 `<Modal>`（焦点陷阱、Esc、`aria-labelledby`）和 `useXxxQuery / useXxxMutation` hooks。删除 `SettingsView.tsx` 里两段永远走不到的网站源分支（`542-616`、`704-786`）。
- CSS：`main.tsx` 按顺序加载 10 个全局样式表，按版本层层覆盖（`!important` 共 36 处，另有 2 个从未被引用的样式文件；断点有 480/760/820/900/1100/1199/1350/1599 八种）。收敛为一套设计 token + 组件级样式 + 2–3 个命名断点。
- 打开变动时先开弹窗、并行标记已读（现在是先等 `POST /read` 再请求详情的瀑布）。
- 渲染：聊天行 `memo`；课程卡片的计数用 `useMemo` 建索引；缓存 `Intl.DateTimeFormat`。

**与新后端的接口约定**：字段保持 snake_case；错误体为 `{"detail": "...", "code": "..."}`，校验错误 422 时 `detail` 为 `{loc, msg}` 列表；同步为 202 + 轮询。

**第 2 周的接口决定**：不再照搬旧的 69 个路径（第 6 节第 1 条的“契约优先”只保留字段风格和错误体），而是按资源重新设计 REST 接口（`/api/courses`、`/api/tasks`、`/api/files`、`/api/changes`、`/api/canvas/connection`、`/api/sync`），清单见 README。原因：旧路径是“每用户一个后端进程”时代的产物，大量是动作式路径（`/sync/run`、`/changes/{id}/read`），且很多读接口会写库。前端因此在 `frontend/src/app/` 新写了一套基于 React Router 的界面，旧界面文件暂留在 `frontend/src/` 但已不再加载，第 3 周补齐 Today、Timeline、Calendar 后删除。

**第 3 周的结果**：旧界面（`frontend/src` 下 50 个文件，其中 13 个样式表）、20 个旧测试和 12 个只给旧界面用的依赖（FullCalendar、Markdown/KaTeX 渲染、zod）已删除，前端只剩 `main.tsx` + `app/`，打包后的 JS 从约 642 KB 降到约 462 KB。样式收敛为一个 `app.css`：深浅色两套 token；断点从 8 种减到 5 种（手机 ≤479、640、720 文件表、900 侧边栏、1100 双栏）；触控目标不低于 44 px；`prefers-reduced-motion` 下关闭动画；`!important` 从 36 处减到 5 处，只留在读屏隐藏工具类和减少动画规则里。Today 计划的算法放在服务端（`server/src/today/plan.ts`，纯函数、有单元测试）：学习时段扣掉忙碌事件得到空闲时间，再按截止时间、剩余工作量和逾期程度排序分配，每项给出一句理由；前端只负责展示，不再在浏览器里重算。

### 7.4 启发式评估的基线问题（第 1 轮评估前已知）

1. **系统状态可见性**：顶部 “Sync now” 不显示结果或错误，失败无声（`App.tsx:475`）。
2. **系统与现实匹配**：内部术语直接给用户看，如 “TODAY EXECUTION SIGNAL”、“fallback capacity”、原始枚举值、“Internal metadata” JSON（`TodayView.tsx:56-68`、`App.tsx:1327`）。
3. **识别而非回忆**：保存按钮只有一个 ✓（`CommitButton.tsx:10-13`），另有隐藏的全局回车提交。
4. **用户控制与防错**：点遮罩直接关闭编辑器并丢弃未保存内容（`SettingsView.tsx:392,665,1631`）；归档用原生 `confirm()`。
5. **错误恢复**：错误以 `String(reason)` 原样显示 “Error: …”；课程加载中就显示 “Course not found”（`App.tsx:1067`）。
6. **可访问性**：课程卡片是可点击的 `article` 内嵌按钮、空格键无效（`App.tsx:871-907`）；变动弹窗无 Esc、无焦点陷阱；导航图标字符会被读屏朗读。

## 8. 团队角色

| 角色 | 负责 | 主要交付物 |
| --- | --- | --- |
| 项目经理 / UX 负责人 | 需求与范围、线框、组织启发式评估与可用性测试 | 线框图、`heuristic-evaluation.md`、演示脚本 |
| 前端负责人 | 前端重构、设计系统、响应式、可访问性 | `frontend/`、组件库、Lighthouse 报告 |
| 后端负责人 | Express API、认证、契约测试、API 文档 | `server/src/{app,auth,routes}`、OpenAPI |
| 数据与集成 | Prisma 模型与迁移、Canvas 同步、后台任务 | `server/prisma`、`server/src/{sources,jobs}` |
| DevOps / QA（第 5 人） | CI、部署、E2E 测试、种子数据 | GitHub Actions、`docker-compose.yml`、Playwright 用例 |

3 人团队：PM/UX 兼前端，后端兼 DevOps，数据与集成兼 QA。

## 9. 里程碑（按 6 周估算，按实际截止日期调整）

| 周 | 后端 | 前端 / UX |
| --- | --- | --- |
| 1 | 仓库重组；Node 骨架；Prisma schema；认证；CI | 现有界面问题清单；线框；设计 token |
| 2 | Canvas 连接与同步；courses / tasks / files / changes 只读接口 | 前端切到新后端；引入路由；登录与引导页 |
| 3 | Today、Timeline、Calendar；全部写操作 | 设计系统收敛；空状态、加载骨架、错误恢复 |
| 4 | 补测试与性能（索引、分页） | **启发式评估第 1 轮**：3–5 名评估者独立评分（严重度 0–4），合并问题表 |
| 5 | 加分项（AI 聊天或 Google 日历选一） | **修订**并做第 2 轮复评，记录前后对比；响应式与可访问性检查 |
| 6 | 部署、种子演示数据、删除 `legacy/` | 演示准备、文档定稿 |

**进度**：第 1–3 周已完成。第 2 周交付：Canvas 连接（token 加密保存、主机白名单）、手动与定时同步、courses / tasks / files / changes 只读接口及已读、归档两个写操作；前端改为 React Router 单页应用，包含登录、注册、三步引导、首页、课程、课程详情、变动、文件、设置页面，手机底部标签栏、桌面侧边栏，深浅色主题。

第 3 周交付：
- **后端**：`GET /api/today`（今日计划）；任务写操作（完成、忽略、进度、预计时长、备注；个人任务的新建、改标题/类型/截止时间、删除；Canvas 任务的标题和截止时间仍由 Canvas 决定，改动返回 409）；日历事件增删改、.ics 导入与删除（`server/src/calendar/ics.ts`，处理折行、时区、全天事件和重复规则，只保留一个月前到一年后的事件）；学习设置（时区、每日目标、学习时段）。迁移 `20261107010633_week3_plan_calendar`。
- **前端**：Today 页（今日计划与理由、今日事件、勾选完成后可撤销）；日历页的周视图和 Timeline 视图（未来四周按天汇总工作量，对比每日目标）；任务编辑弹窗（进度滑块、未保存修改的离开确认）；事件新建/编辑、.ics 导入；设置页新增学习计划和日历管理。各列表都有加载骨架、空状态和带重试的错误提示。
- **测试**：后端 vitest（含 .ics 解析、计划算法、各写接口与权限）；前端 `node --test` 覆盖时区换算（含夏令时切换）、表单校验与请求体、日期文案。

## 10. 风险与待定事项

- **“JavaScript 后端”的认定**：若课程不接受 TypeScript，改用纯 JS + JSDoc 类型检查。
- **Canvas 访问**：确认学校 Canvas 允许学生生成个人 access token；不允许时用种子数据 + 公开 ICS 演示。启发式评估的参与者未必有 Canvas token，第 4 周前需要一个演示数据种子。
- **范围**：严格按第 4 节裁剪；加分项只在 MVP 稳定后开始。
- **部署隔离**：课程版与线上 Watcher 完全分开（独立数据库、独立域名或路径），不读写线上数据。
