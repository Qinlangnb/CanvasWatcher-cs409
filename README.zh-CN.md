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
| 演示账号、变动列表索引、文件分页 | 已完成（第 4 周），有测试；改动前后的查询实测见 [performance.md](docs/cs409/performance.md) |
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
| `DELETE /api/sessions/current` | 登出当前浏览器（演示账号登出即删除） | 204 |
| `GET /api/demo` | 本服务器是否提供演示账号 | 200 |
| `POST /api/demo` | 仅限未登录：新建带示例数据的演示账号并登录（同一网络每小时 10 个） | 201 |
| `POST /api/demo/reset` | 仅限演示账号：恢复示例数据 | 204 |
| `GET /api/canvas/connection` | Canvas 站点、账号、状态与上次同步时间 | 200 |
| `PUT /api/canvas/connection` | 验证 Canvas access token，加密保存，开始首次同步 | 200 |
| `DELETE /api/canvas/connection` | 删除 token 与所有已同步数据 | 204 |
| `POST /api/sync` | 开始同步；按 `Location` 轮询进度 | 202 |
| `GET /api/sync/runs/latest`、`GET /api/sync/runs/{id}` | 同步进度与结果 | 200 |
| `GET /api/courses[?archived=true]` | 当前（或仅已归档）课程及计数 | 200 |
| `GET /api/courses/{id}`、`PATCH /api/courses/{id}` | 单门课程；归档或恢复 | 200 |
| `GET /api/tasks[?course_id=&status=all&due_after=&due_before=]` | 未完成（或全部）任务，按截止时间排序，无截止的排最后 | 200 |
| `POST /api/tasks` | 在自己的某门课下新建个人任务 | 201 |
| `GET /api/tasks/{id}`、`PATCH /api/tasks/{id}` | 单个任务；设置 `done`、`ignored`、`progress`、`estimated_minutes`、`notes`（个人任务还可改 `title`、`type`、`due_at`） | 200 |
| `DELETE /api/tasks/{id}` | 删除个人任务（Canvas 任务只能忽略） | 204 |
| `GET /api/today` | 今日计划：学习时段内扣除忙碌事件后的空闲时间、带理由的计划任务、今天的事件、今天已完成的任务 | 200 |
| `GET /api/calendar/events?from=&to=` | 与区间重叠的事件（导入的与自建的） | 200 |
| `POST /api/calendar/events`、`PATCH /api/calendar/events/{id}`、`DELETE /api/calendar/events/{id}` | 新建、修改、删除自建事件；忙碌事件会从计划里扣除时间 | 201、200、204 |
| `GET /api/calendar/sources`、`POST /api/calendar/sources`、`DELETE /api/calendar/sources/{id}` | 导入的 .ics 日历：列表、导入（最大 1.5 MB，最多 20 个）、连同事件一起删除 | 200、201、204 |
| `GET /api/settings`、`PATCH /api/settings` | 时区、每日学习目标与学习时段 | 200 |
| `GET /api/files[?course_id=&q=&limit=&cursor=]` | 文件元数据，最新在前；返回 `{ items, next_cursor }`，默认每页 50 个 | 200 |
| `GET /api/files/{id}/download` | 302 跳转到 Canvas 新生成的下载链接 | 302 |
| `GET /api/changes[?course_id=&unread=&limit=&before=]` | 变动列表，最新在前，游标分页 | 200 |
| `GET /api/changes/unread-count`、`POST /api/changes/mark-all-read` | 未读数；全部（或某门课）标为已读 | 200 |
| `GET /api/changes/{id}`、`PATCH /api/changes/{id}` | 单条变动及前后值；设置 `read` | 200 |

**演示账号**让没有 Canvas token 的人（例如启发式评估的评估者）也能试用。只有 `DEMO_ACCOUNTS=true` 时开启，`docker-compose.yml` 默认开启。

- 每点一次“Try a demo”就新建一个独立账号，没有密码，带有以当天为基准的示例课程、任务、文件、变动和日历事件。
- 用户结束演示时删除账号，否则 7 天后删除。
- 演示账号从不访问 Canvas：
  - 同步立即完成。
  - 下载返回 409 `DEMO_FILE`。
  - 连接 Canvas、修改密码返回 403 `DEMO_ACCOUNT`。
  - 定时同步跳过演示账号。

默认只允许连接 `canvas.illinois.edu` 与 `*.instructure.com`（`CANVAS_ALLOWED_HOSTS`）。连接期间每个账号每 `SYNC_INTERVAL_MINUTES`（默认 30）分钟自动同步一次；Canvas 拒绝 token 后停止自动同步，直到用户重新连接。

错误统一为 JSON：`{ "detail": "<给用户看的句子>", "code": "<机器码>" }`；校验错误返回 422，`detail` 为 `{ loc, msg }` 列表。会话使用 httpOnly Cookie；修改状态的请求必须带允许的 `Origin`，登录后还需带 `X-AW-CSRF` 头（取自 `aw_csrf` Cookie）。

## 启动完整服务

安装 Docker Desktop（或 Docker Engine 与 Compose v2）后运行：

```sh
cp .env.example .env    # 再设置 SESSION_SECRET 与 CREDENTIALS_KEY（见文件内注释）
docker compose up -d --build
```

打开 `http://localhost:8080`。nginx 提供前端并把 `/api` 转发到 API 容器，API 端口不对外发布；PostgreSQL 只监听 `127.0.0.1:5432`；该端口被占用或被 Windows 保留时，在 `.env` 设置 `POSTGRES_PORT`，并在 `server/.env` 使用同一端口。Windows PowerShell 可用 `Copy-Item` 替代 `cp`。

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
| `server/` | Node.js REST API：Express 路由、Prisma 数据模型与迁移、演示账号（`src/demo/`）、测试、查询基准（`bench/`） |
| `frontend/src/app/` | React 界面：`router.tsx`（路由与登录守卫）、`pages/`、公共组件 `ui.tsx`、`queries.ts`（React Query hooks）、`tasks.tsx` 与 `events.tsx`（编辑器）、`demo.tsx`（演示入口、横幅与对话框）、`forms.ts` 与 `zoned.ts`（表单与时区的纯函数，有单元测试）、`app.css`（设计 token，深浅色） |
| `docs/cs409/` | 重写方案、性能实测、启发式评估材料 |
| `legacy/` | 原 Python 后端、网关与部署文件，仅作移植对照 |

## 许可

项目采用 [GNU GPL 第 2 版](LICENSE) 发布，第三方依赖保留各自许可。开发过程中使用了 AI 编码代理，由人制定需求并完成审查。
