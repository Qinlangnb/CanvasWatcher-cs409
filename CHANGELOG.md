# Changelog / 更新记录

## v0.8.1 — parity review fixes / 对照审查修复

### English

- Auth Broker: the broker (now 0.8.1) reports which CanvasWatcher site it serves, and Settings → Sources says when it is set up for another site, outdated, or cannot reach this site, with the commands that register it for this site. Refusals from the broker get specific messages instead of "could not start". A broker registered for an older address (for example the previous site) was the reason browser sign-in failed after the move: re-register it once.
- Sources: changing a Gradescope or PrairieLearn address is probed through the same guarded connection as course websites (no private addresses, no echoed status). A Canvas source can't be pointed at another Canvas site while an account is signed in; the dialog says to disconnect first. A Gradescope source with no linked course reads "Link a course to start syncing" instead of an error, also after unlinking the last course, and is not scheduled. Course-website files above the size limit are listed as "too large to store" with a link to the site and are not downloaded again every sync; only the schedule page sets homework deadlines, and disagreeing pages are reported; .docx, .txt and .md files are read for the syllabus.
- Tasks: saving 100% from the task dialog or through AI Chat completes the task, stops its timer and records history like the progress slider; quick slider moves no longer report a false "changed elsewhere"; work overdue by more than a week is listed on Today.
- Calendar: repeating events starting on the last evening of a view are shown; Day view hours are right on daylight-saving days; large calendars are no longer cut at 2,000 events; all-day import ranges show the right dates; an event linked to an archived course keeps that course in the editor.
- Changes: the unread count and Mark all as read follow the selected course and the Important/Everything view; an old critical banner is no longer hidden behind newer notices.
- Found by five DeepSeek parity reviews of v0.8.0 against the earlier app (21 findings, 20 confirmed and fixed, 1 not reproducible) and a verify pass (2 more small fixes).

### 中文

- Auth Broker：Broker（现为 0.8.1）会报告自己服务的 CanvasWatcher 站点；Settings → Sources 会提示它注册到了别的站点、版本过旧或连不上本站，并给出重新注册到本站的命令。Broker 拒绝请求时显示具体原因，而不是笼统的 "could not start"。迁移后浏览器登录失败，原因就是 Broker 仍注册在旧地址（例如原来的站点），重新注册一次即可。
- 来源：修改 Gradescope 或 PrairieLearn 地址时，探测请求与课程网站走同样的受限连接（不访问私有地址，不回显对方状态码）。已登录账号的 Canvas 来源不能改指向另一个 Canvas 站点，对话框会提示先断开连接。未关联课程的 Gradescope 来源显示 "Link a course to start syncing" 而非错误，取消最后一门课的关联后也一样，且不会被定时同步。超过大小上限的课程网站文件会以 "too large to store" 列出并链接到网站，不再每次同步都重新下载；作业截止日期只取自进度表页面，页面之间不一致时会报告；.docx、.txt、.md 文件会被读取用于查找教学大纲。
- 任务：在任务对话框或通过 AI Chat 保存 100% 会完成任务、停止计时并记录历史，与进度条一致；快速拖动进度条不再误报"已在别处修改"；逾期超过一周的作业会在 Today 中列出。
- 日历：在视图最后一晚开始的重复事件会正常显示；夏令时切换当天的日视图小时格正确；大型日历不再在 2000 个事件处截断；全天事件导入范围的日期正确；关联到已归档课程的事件在编辑时保留该课程。
- 变更：未读数和 "Mark all as read" 会按所选课程和 Important/Everything 视图计算；较旧的严重通知不再被新通知挤掉。
- 以上问题来自 DeepSeek 对 v0.8.0 与原版的五块对照审查（21 条，20 条确认并修复，1 条不成立）以及一轮复核（另外 2 处小修复）。

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
