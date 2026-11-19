# Changelog / 更新记录

## v0.8.0 — the TypeScript app becomes the official version / TypeScript 版成为正式版

### English

- This codebase replaces the earlier Python app as the official CanvasWatcher. Everything the earlier app did is now part of the multi-user Node.js and PostgreSQL server, and `legacy/` stays only as a reference.
- Sources: Canvas with personal access token (expiry date and reminders), browser session and optional OAuth slots that fail over to each other, refusing a different Canvas account; browser sign-in through the Auth Broker (now in `auth-broker/`, version 0.8.0, with optional autostart on Windows) or a pasted cURL/Cookie header; course websites, public or NTLM-protected, with crawling inside the course path, checked file downloads, a per-user storage quota, pending protected pages and an optional homework schedule; Gradescope course linking and submission facts on tasks; PrairieLearn sign-in. Settings → Sources and a SOURCES list in the sidebar show each source's health, diagnostics and sign-in state.
- Today: work timers, progress saved with conflict protection and Reopen, priorities, capacity from weekly study availability less classes, busy events and commute, "Needs attention" for AI-reviewed changes, assignment file downloads, AI summaries of assignment descriptions and AI time estimates.
- Calendar: Day and Month views, a draggable course timeline, Workload, repeating events with course, type and time zone, .ics preview and re-import, weekly availability, date overrides, commute per course and a 31-day agenda.
- Courses, changes and files: term filter, archive and restore, grading policy, Active / Completed / Ignored tasks, grade releases and deadline changes in an Important view, an optional AI review with learned noise filters and banners, file types with "Move to…".
- AI: each user can connect their own provider (Kimi, DeepSeek, Qwen, GLM, GPT, Claude) with a tested model; AI Chat keeps conversations on the server, has more read tools, renders math and asks for confirmation before changing tasks, courses or calendar events.
- Settings are grouped into General, Sources, Calendar and AI and changes tabs. Layouts were checked at 360, 390, 768, 1440 and 1920 px wide in light and dark mode; README screenshots now show desktop, tablet, phone and wide-screen sizes with a fictional demo account.
- Behaviour changes: connecting a token for a different Canvas account now fails instead of replacing the old account's data (disconnect first); a time without an offset sent to the calendar API is read in the user's time zone.

### 中文

- 本代码库取代早期 Python 版本，成为 CanvasWatcher 正式版。早期版本的全部功能都已并入多用户的 Node.js + PostgreSQL 服务；`legacy/` 仅作参考保留。
- 来源：Canvas 支持个人访问令牌（到期日与提醒）、浏览器会话和可选的 OAuth 三个凭据槽，互为备份并自动切换，拒绝另一个 Canvas 账号；可通过 Auth Broker（现位于 `auth-broker/`，版本 0.8.0，Windows 上可选开机自启）用浏览器登录，或粘贴 cURL/Cookie；课程网站支持公开和 NTLM 保护，只在课程路径内抓取，下载文件经过校验，有每用户存储配额，列出待登录的受保护页面，可选作业进度表；Gradescope 课程关联并在任务上显示提交信息；PrairieLearn 登录。Settings → Sources 和侧栏的 SOURCES 列表显示每个来源的健康状态、诊断和登录情况。
- Today：计时器、带冲突保护的进度保存和 Reopen、优先级、按每周可用时间扣除上课、忙碌事件和通勤得出的可用时长、显示 AI 审核变更的 "Needs attention"、作业附件下载、作业说明的 AI 概括和 AI 估时。
- 日历：日视图和月视图、可拖动的课程时间线、Workload、可关联课程/类型/时区的重复事件、.ics 预览与重新导入、每周可用时间、按日期覆盖、每门课通勤时间和 31 天日程。
- 课程、变更与文件：学期筛选、归档与恢复、评分政策、Active / Completed / Ignored 任务、Important 视图中的成绩发布与截止日期变化、可选的 AI 审核及其学到的噪声过滤规则与通知横幅、文件类型与 "Move to…"。
- AI：每位用户可以连接自己的服务商（Kimi、DeepSeek、通义千问、智谱 GLM、GPT、Claude），模型须先通过测试；AI Chat 的对话保存在服务器上，读取工具更多，能渲染数学公式，修改任务、课程或日历事件前会请求确认。
- 设置分为 General、Sources、Calendar、AI and changes 四个标签页。布局已在 360、390、768、1440、1920 px 宽度及浅色/深色模式下检查；README 截图改为虚构演示账号在桌面、平板、手机和宽屏下的效果。
- 行为变化：连接另一个 Canvas 账号的令牌现在会失败，不再覆盖原账号的数据（需先断开连接）；发给日历 API、不带时区偏移的时间按用户所在时区解读。

## Unreleased (legacy Python app) — Azure multi-user preview / Azure 多用户预览

### English

- Added an invitation-only identity gateway with per-user backend processes, SQLite databases, encrypted credentials, file trees, and quotas. The default local Compose deployment remains single-user.
- Brought source synchronization, assignment attachments, page availability, AI summaries, responsive Today cards, and Broker direct-HTTPS support forward from the private development branch.
- Added generic Linux deployment templates. Domain, owner identity, credentials, database, and server-specific configuration must be supplied by each operator. Fresh multi-user first-admin bootstrapping is not automated in this preview.
- Split the repository README into English and Chinese files.

### 中文

- 新增邀请制身份网关，为每位用户隔离后端进程、SQLite、加密凭据、文件树和配额；默认本地 Compose 仍为单用户。
- 同步私有开发分支中的来源采集、作业附件、Pages 可用性、AI 概括、Today 响应式布局及 Broker 直连 HTTPS 支持。
- 加入通用 Linux 部署模板；域名、管理员身份、凭据、数据库与服务器专属配置须由部署者提供。预览版尚未自动化全新多用户实例的首位管理员初始化。
- 将仓库 README 拆为英文和中文两份。

## v0.7.2

### 中文

- Windows 可一次注册本机 Auth Broker 启动器，之后从 Settings → Sources 选择 Start broker；`academicwatcher://start` 最多等待 60 秒检查 Broker 健康状态。网页不再提供安装说明。
- Broker 启动保持单实例，并只管理其自身创建的子进程；Sources 可检查 Broker health，并修复瞬时刷新响应处理。
- 一键模式默认允许 `http://localhost:8080` 与 `http://127.0.0.1:8080`，使用固定 Broker `127.0.0.1:8765` 和后端 `http://127.0.0.1:8000`。启动器只管理 Broker，不控制 Docker。

### English

- Windows can register the local Auth Broker launcher once, then select Start broker in Settings → Sources. `academicwatcher://start` waits up to 60 seconds for Broker health. Setup instructions are removed from the web UI.
- Broker startup is single-instance and manages only its own child process; Sources can check Broker health, with a fix for transient refresh responses.
- One-click mode allows `http://localhost:8080` and `http://127.0.0.1:8080` by default, with fixed Broker `127.0.0.1:8765` and backend `http://127.0.0.1:8000`. The launcher manages only the Broker, not Docker.

## v0.7.1 — first public release / 首次公开版本

### 中文

- 首次公开发布，提供 Canvas 与课程站点同步、截止日期和任务管理、重要变更展示、学习规划、可选 AI 审核，以及独立的本机 Auth Broker 登录流程。

### English

- First public release, with Canvas and course-site synchronization, deadlines and task management, important-change display, study planning, optional AI review, and a separate host-side Auth Broker sign-in flow.
