# CanvasWatcher / Academic Watcher — CS409

> **CS409 分支。** 本仓库是 [CanvasWatcher](https://github.com/Qinlangnb/CanvasWatcher) 的课程项目分支。后端正在改写为基于 **Node.js + TypeScript** 的单一多用户 REST API（Express、PostgreSQL、Prisma）。原 Python 服务移入 [`legacy/`](legacy/README.md)，仅作移植对照，不再构建、测试或部署。详见[重写方案](docs/cs409/REWRITE_PLAN.zh-CN.md)。

[English README](README.md) · [重写方案](docs/cs409/REWRITE_PLAN.zh-CN.md) · [GPL-2.0](LICENSE)

CanvasWatcher 从 Canvas 和受支持的课程网站汇集资料、截止日期、任务与有意义的变更，提供 Today 规划、文件历史、日历导入和可选 AI 辅助。来源同步只读。

![使用合成课程与任务的 Today 页面](docs/screenshots/today-demo.png)

*原版应用截图，使用合成演示数据。*

## 重写进度

| 部分 | 状态 |
| --- | --- |
| 账号与会话 | 已完成（第 1 周），有测试 |
| Canvas 连接、手动与定时同步 | 已完成（第 2 周），用假的 Canvas 服务器测试 |
| 课程、任务、文件、变动（只读、标记已读、归档） | 已完成（第 2 周） |
| Today 计划、Timeline、日历（.ics 导入、自建事件）、学习设置、任务编辑 | 已完成（第 3 周），有测试 |
| 演示账号（现为 Preview 预览账号）、变动列表索引、文件分页 | 已完成（第 4 周），有测试；改动前后的查询实测见 [performance.md](docs/cs409/performance.md) |
| Today 的 Due next week（在计划排到之前就开始做）、同步结果提示 | 已完成（第 4 周，第 1 轮评估前），有测试 |
| 启发式评估 | 第 1 轮材料已备好，见 [heuristic-evaluation.md](docs/cs409/heuristic-evaluation.md)；尚未进行 |
| 前端 | 在 `frontend/src/app` 用 React Router 重写：登录、注册、引导、Today、日历（周视图与 Timeline）、课程、变动、文件、设置；旧界面已在第 3 周删除 |

### API

| 方法与路径 | 作用 | 成功状态 |
| --- | --- | --- |
| `GET /api/health` | 数据库连通检查 | 200 |
| `POST /api/users` | 注册并登录 | 201 |
| `GET /api/users/me` | 当前登录用户 | 200 |
| `PUT /api/users/me/password` | 修改密码，并登出其他设备 | 204 |
| `POST /api/sessions` | 用用户名或邮箱登录 | 201 |
| `DELETE /api/sessions/current` | 登出当前浏览器（预览账号登出即删除） | 204 |
| `GET /api/preview` | 本服务器是否提供预览 | 200 |
| `POST /api/preview` | 仅限未登录：新建一个预览账号（模板账号数据的去身份副本）并登录（同一网络每分钟 120 个；同时存在的预览数不设上限） | 201 |
| `POST /api/preview/reset` | 仅限预览账号：重新复制模板数据 | 204 |
| `GET /api/canvas/connection` | Canvas 站点、账号、状态与上次同步时间 | 200 |
| `PUT /api/canvas/connection` | 验证 Canvas access token，加密保存，开始首次同步 | 200 |
| `DELETE /api/canvas/connection` | 删除 token 与所有已同步数据 | 204 |
| `POST /api/sync` | 开始同步；按 `Location` 轮询进度 | 202 |
| `GET /api/sync/runs/latest`、`GET /api/sync/runs/{id}` | 同步进度与结果 | 200 |
| `GET /api/courses[?archived=true]` | 当前（或仅已归档）课程及计数 | 200 |
| `GET /api/courses/{id}`、`PATCH /api/courses/{id}` | 单门课程；归档或恢复 | 200 |
| `GET /api/courses/{id}/syllabus` | 课程 syllabus（无论老师放在哪里），从 Canvas 读取；无法访问 Canvas 时返回上次读取保存的副本（`saved_copy: true`） | 200 |
| `GET /api/tasks[?course_id=&status=all&due_after=&due_before=]` | 未完成（或全部）任务，按截止时间排序，无截止的排最后 | 200 |
| `POST /api/tasks` | 在自己的某门课下新建个人任务 | 201 |
| `GET /api/tasks/{id}`、`PATCH /api/tasks/{id}` | 单个任务（含 Canvas 作业说明 `description`）；设置 `done`、`ignored`、`progress`、`estimated_minutes`、`spent_minutes`、`notes`、`start_today`（个人任务还可改 `title`、`type`、`due_at`） | 200 |
| `DELETE /api/tasks/{id}` | 删除个人任务（Canvas 任务只能忽略） | 204 |
| `GET /api/today` | 今日计划：学习时段内扣除忙碌事件后的空闲时间、带理由的计划任务、未来 7 天内到期的未完成任务、今天的事件、今天已完成的任务 | 200 |
| `GET /api/calendar/events?from=&to=` | 与区间重叠的事件（导入的与自建的） | 200 |
| `POST /api/calendar/events`、`PATCH /api/calendar/events/{id}`、`DELETE /api/calendar/events/{id}` | 新建、修改、删除自建事件；忙碌事件会从计划里扣除时间 | 201、200、204 |
| `GET /api/calendar/sources`、`POST /api/calendar/sources`、`DELETE /api/calendar/sources/{id}` | 导入的 .ics 日历：列表、导入（最大 1.5 MB，最多 20 个）、连同事件一起删除 | 200、201、204 |
| `GET /api/settings`、`PATCH /api/settings` | 时区、每日学习目标与学习时段 | 200 |
| `GET /api/files[?course_id=&q=&limit=&cursor=]` | 文件元数据，最新在前；返回 `{ items, next_cursor }`，默认每页 50 个 | 200 |
| `GET /api/files/{id}/download` | 302 跳转到 Canvas 新生成的下载链接 | 302 |
| `GET /api/changes[?course_id=&unread=&limit=&before=]` | 变动列表，最新在前，游标分页 | 200 |
| `GET /api/changes/unread-count`、`POST /api/changes/mark-all-read` | 未读数；全部（或某门课）标为已读 | 200 |
| `GET /api/changes/{id}`、`PATCH /api/changes/{id}` | 单条变动及前后值；设置 `read` | 200 |
| `GET /api/ai` | AI Chat 是否已配置及所用模型 | 200 |
| `POST /api/ai/chat` | 一轮 AI Chat：传入 `{ messages, page }`，返回 `{ message, tools_used }`（每账号、每网络每 10 分钟分别限 30、120 次） | 200 |

**预览账号**让没有账号或 Canvas token 的人（例如启发式评估的评估者）用真实课程数据试用。只有 `PREVIEW_SOURCE_USERNAME` 指向服务器上已有的账号（模板）时开启。

- 登录页每点一次 **Preview** 就新建一个独立、无密码的账号，复制模板的课程、任务（含个人任务和备注）、文件、变动、日历、设置和保存的 syllabus。
- 副本去掉了模板的身份：邮箱、用户名、Canvas 姓名（及其中每个词）和 Canvas 用户 ID 在所有复制的文本和前后值里都被替换。任务或事件里手写的其他个人信息原样复制。
- 其余功能和普通账号一样可用，修改不会影响模板。**Reset** 重新复制模板。
- 用户结束预览时删除账号，否则 7 天后删除。
- 预览没有 Canvas token，从不访问 Canvas：连接或断开 Canvas、同步、下载、修改密码返回 403 `PREVIEW_ACCOUNT`（"Preview account not available."），界面上显示为灰色。syllabus 显示模板保存的副本（没有副本时返回 403）。定时同步跳过预览账号。
- AI Chat 在预览中使用服务器的 key，读取预览自己的数据副本。

**任务**记录进度、自己的估计和已用时间（`spent_minutes`）。同时填了已用时间和进度后，剩余时间按目前的速度算（`remaining_basis: "pace"`：30% 用了 90 分钟，剩下约 210 分钟）；否则按估计或该类型的常用时长。每次同步保存 Canvas 分数（`score`、`grade`、`excused`），null 表示尚未评分或对学生隐藏。

**AI Chat** 通过 OpenAI 兼容的 chat completions 接口回答关于当前学生课程的问题（`AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`；默认 DeepSeek `deepseek-flash`；key 为空则关闭）。模型只能通过只读工具读取：课程、带分数和剩余时间的任务、单个任务及其 Canvas 说明、syllabus（同步约每天刷新一次保存的副本）、日历事件、最近变动和文件名，不能修改任何内容。对话只保存在浏览器标签页，每次随消息发送，服务器不保存。每轮最多 8 次查询，约 90 秒内返回。

默认只允许连接 `canvas.illinois.edu` 与 `*.instructure.com`（`CANVAS_ALLOWED_HOSTS`）。连接期间每个账号每 `SYNC_INTERVAL_MINUTES`（默认 30）分钟自动同步一次；Canvas 拒绝 token 后停止自动同步，直到用户重新连接。

错误统一为 JSON：`{ "detail": "<给用户看的句子>", "code": "<机器码>" }`；校验错误返回 422，`detail` 为 `{ loc, msg }` 列表。会话使用 httpOnly Cookie；修改状态的请求必须带允许的 `Origin`，登录后还需带 `X-AW-CSRF` 头（取自 `aw_csrf` Cookie）。

## 启动完整服务

安装 Docker Desktop（或 Docker Engine 与 Compose v2）后运行：

```sh
cp .env.example .env    # 再设置 SESSION_SECRET 与 CREDENTIALS_KEY（见文件内注释）
docker compose up -d --build
```

打开 `http://localhost:8080`。nginx 提供前端并把 `/api` 转发到 API 容器，API 端口不对外发布；PostgreSQL 只监听 `127.0.0.1:5432`；该端口被占用或被 Windows 保留时，在 `.env` 设置 `POSTGRES_PORT`，并在 `server/.env` 使用同一端口。Windows PowerShell 可用 `Copy-Item` 替代 `cp`。

若要在另一个反向代理后以子路径提供服务（如 `https://example.com/cs409/`），在 `.env` 设置 `PUBLIC_BASE_PATH=/cs409` 并重新构建，代理原样转发该路径（nginx 会在转给 API 前去掉它）。前端按该路径构建，登录 cookie 也限定在该路径下，同站点的其他应用无法覆盖。该代理多了一跳：若它设置 `X-Forwarded-For`，在 Compose override 文件中为 `backend` 设置 `TRUST_PROXY: "2"`。

## 开发

需要 Node.js 22.12 或更新版本。

```sh
docker compose up -d db          # 只启动 PostgreSQL
cd server
cp .env.example .env             # 再设置 SESSION_SECRET 与 CREDENTIALS_KEY
npm install                      # 同时生成 Prisma Client
npm run db:deploy                # 应用迁移
npm run dev                      # API 运行在 http://localhost:8000，保存即重启
```

另开终端执行 `cd frontend && npm install && npm run dev`，界面位于 `http://localhost:5173`，`/api` 代理到 `localhost:8000`（可用 `VITE_API_PROXY` 覆盖）。

`server/.env.example` 默认关闭预览。开发时若要在登录页显示 **Preview**，在 `server/.env` 中把 `PREVIEW_SOURCE_USERNAME` 设为一个已有账号的用户名。要开启 AI Chat，设置 `AI_API_KEY`（只写在 `.env`，不要提交）。

| `server/` 下的命令 | 作用 |
| --- | --- |
| `npm test` | 创建并迁移 `canvaswatcher_test`，运行 Vitest + Supertest 测试 |
| `npm run typecheck` | 检查源码与测试的类型 |
| `npm run build` | 编译到 `dist/` |
| `npm run db:migrate -- --name <变更名>` | 修改 `prisma/schema.prisma` 后生成迁移 |
| `npm run bench -- [--out results.json]` | 在临时库 `canvaswatcher_bench` 中生成大量合成数据，测量请求耗时并输出 `EXPLAIN ANALYZE` 执行计划（见 [performance.md](docs/cs409/performance.md)） |

CI（`.github/workflows/ci.yml`）会在 PostgreSQL 服务上运行后端检查，并运行前端测试与构建。

## 源码结构

| 路径 | 用途 |
| --- | --- |
| `server/` | Node.js REST API：Express 路由、Prisma 数据模型与迁移、预览账号（`src/preview/`）、AI Chat（`src/ai/`）、测试、查询基准（`bench/`） |
| `frontend/src/app/` | React 界面：`router.tsx`（路由与登录守卫）、`pages/`、公共组件 `ui.tsx`、`queries.ts`（React Query hooks）、`tasks.tsx` 与 `events.tsx`（编辑器）、`preview.tsx`（预览入口、横幅与对话框）、`aiChat.tsx`（AI Chat 抽屉）、`taskCard.tsx`（展开的任务详情）、`forms.ts` 与 `zoned.ts`（表单与时区的纯函数，有单元测试）、`app.css`（设计 token，深浅色） |
| `docs/cs409/` | 重写方案、性能实测、启发式评估材料 |
| `legacy/` | 原 Python 后端、网关与部署文件，仅作移植对照 |

## 许可

项目采用 [GNU GPL 第 2 版](LICENSE) 发布，第三方依赖保留各自许可。开发过程中使用了 AI 编码代理，由人制定需求并完成审查。
