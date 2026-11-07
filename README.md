# CanvasWatcher / Academic Watcher — CS409

> **CS409 fork.** This repository is the course-project fork of [CanvasWatcher](https://github.com/Qinlangnb/CanvasWatcher). The backend is being rewritten as a single multi-user REST API in **TypeScript on Node.js** (Express, PostgreSQL, Prisma). The original Python services live in [`legacy/`](legacy/README.md) only as a porting reference; they are not built, tested or deployed. See the [rewrite plan](docs/cs409/REWRITE_PLAN.zh-CN.md).

[中文说明](README.zh-CN.md) · [Rewrite plan](docs/cs409/REWRITE_PLAN.zh-CN.md) · [GPL-2.0](LICENSE)

CanvasWatcher collects course materials, deadlines, tasks, and meaningful changes from Canvas and supported course sites. It offers a Today planner, file history, calendar imports, and optional AI assistance. Source synchronization is read-only.

![Today dashboard with synthetic courses and tasks](docs/screenshots/today-demo.png)

*A screenshot of the original application using synthetic demo data.*

## Rewrite status

| Area | State |
| --- | --- |
| Accounts and sessions | Done (week 1), with tests |
| Canvas connection, manual and scheduled sync | Done (week 2), tested against a fake Canvas server |
| Courses, tasks, files, changes (read, mark read, archive) | Done (week 2) |
| Today plan, Timeline, Calendar (.ics import, own events), study settings, task edits | Done (week 3), with tests |
| Frontend | Rewritten in `frontend/src/app` with React Router: sign-in, sign-up, onboarding, Today, Calendar (week and timeline views), Courses, Changes, Files, Settings. The previous interface was deleted in week 3 |

### API

| Method and path | Purpose | Success |
| --- | --- | --- |
| `GET /api/health` | Database reachability | 200 |
| `POST /api/users` | Create an account and sign in | 201 |
| `GET /api/users/me` | The signed-in user | 200 |
| `PUT /api/users/me/password` | Change the password; signs out other devices | 204 |
| `POST /api/sessions` | Sign in with username or email | 201 |
| `DELETE /api/sessions/current` | Sign out this browser | 204 |
| `GET /api/canvas/connection` | Canvas site, account, status and last sync | 200 |
| `PUT /api/canvas/connection` | Check a Canvas access token, store it encrypted, start the first sync | 200 |
| `DELETE /api/canvas/connection` | Delete the token and everything synced | 204 |
| `POST /api/sync` | Start a sync; poll the run in `Location` | 202 |
| `GET /api/sync/runs/latest`, `GET /api/sync/runs/{id}` | Sync progress and result | 200 |
| `GET /api/courses[?archived=true]` | Active (or only archived) courses with counts | 200 |
| `GET /api/courses/{id}`, `PATCH /api/courses/{id}` | One course; archive or restore it | 200 |
| `GET /api/tasks[?course_id=&status=all&due_after=&due_before=]` | Open tasks (or all) by due date, undated last | 200 |
| `POST /api/tasks` | Add a personal task to one of your courses | 201 |
| `GET /api/tasks/{id}`, `PATCH /api/tasks/{id}` | One task; set `done`, `ignored`, `progress`, `estimated_minutes`, `notes` (and `title`, `type`, `due_at` on personal tasks) | 200 |
| `DELETE /api/tasks/{id}` | Delete a personal task (Canvas tasks can only be ignored) | 204 |
| `GET /api/today` | Today's plan: free time in the study window after busy events, planned tasks with reasons, today's events, what was done today | 200 |
| `GET /api/calendar/events?from=&to=` | Events overlapping a range (imported and your own) | 200 |
| `POST /api/calendar/events`, `PATCH /api/calendar/events/{id}`, `DELETE /api/calendar/events/{id}` | Add, edit or delete your own events; busy events take time out of the plan | 201, 200, 204 |
| `GET /api/calendar/sources`, `POST /api/calendar/sources`, `DELETE /api/calendar/sources/{id}` | Imported .ics calendars: list, import (up to 1.5 MB, 20 calendars), remove with their events | 200, 201, 204 |
| `GET /api/settings`, `PATCH /api/settings` | Time zone, daily study goal and study window | 200 |
| `GET /api/files[?course_id=&q=]` | File metadata, newest first | 200 |
| `GET /api/files/{id}/download` | Redirect to a fresh Canvas download link | 302 |
| `GET /api/changes[?course_id=&unread=&limit=&before=]` | Change feed, newest first, cursor paging | 200 |
| `GET /api/changes/unread-count`, `POST /api/changes/mark-all-read` | Unread badge; mark all (or one course) read | 200 |
| `GET /api/changes/{id}`, `PATCH /api/changes/{id}` | One change with before/after values; set `read` | 200 |

Only `canvas.illinois.edu` and `*.instructure.com` can be connected by default (`CANVAS_ALLOWED_HOSTS`). Each account syncs every `SYNC_INTERVAL_MINUTES` (default 30) while connected; a token Canvas rejects stops automatic syncs until the user reconnects.

Errors are JSON: `{ "detail": "<sentence for the user>", "code": "<MACHINE_CODE>" }`. Validation errors return 422 with `detail` as a list of `{ loc, msg }`. Sessions use an httpOnly cookie; state-changing requests need an allowed `Origin` and, once signed in, the `X-AW-CSRF` header copied from the `aw_csrf` cookie.

## Run the whole stack

Install Docker Desktop (or Docker Engine with Compose v2), then:

```sh
cp .env.example .env    # then set SESSION_SECRET and CREDENTIALS_KEY (see the comments in the file)
docker compose up -d --build
```

Open `http://localhost:8080`. nginx serves the frontend and forwards `/api` to the API container; the API port is not published. PostgreSQL listens on `127.0.0.1:5432` only. If that port is taken or reserved (Windows can reserve port ranges), set `POSTGRES_PORT` in `.env` and use the same port in `server/.env`.

## Develop

Requires Node.js 22.12 or newer.

```sh
docker compose up -d db          # PostgreSQL only
cd server
cp .env.example .env             # then set SESSION_SECRET and CREDENTIALS_KEY
npm install                      # also generates the Prisma client
npm run db:deploy                # apply migrations
npm run dev                      # API on http://localhost:8000, restarts on save
```

In another terminal, `cd frontend && npm install && npm run dev` serves the UI on `http://localhost:5173` and proxies `/api` to `localhost:8000` (override with `VITE_API_PROXY`).

| Command (in `server/`) | Does |
| --- | --- |
| `npm test` | Creates and migrates `canvaswatcher_test`, then runs the Vitest + Supertest suite |
| `npm run typecheck` | Type-checks source and tests |
| `npm run build` | Compiles to `dist/` |
| `npm run db:migrate -- --name <change>` | Creates a migration after editing `prisma/schema.prisma` |

CI (`.github/workflows/ci.yml`) runs the server checks against a PostgreSQL service and the frontend tests and build.

## Source tree

| Path | Purpose |
| --- | --- |
| `server/` | Node.js REST API: Express routes, Prisma schema and migrations, tests |
| `frontend/src/app/` | The React interface: `router.tsx` (routes and guards), `pages/`, shared `ui.tsx`, `queries.ts` (React Query hooks), `tasks.tsx` and `events.tsx` (editors), `forms.ts` and `zoned.ts` (pure form and time-zone helpers, unit-tested), `app.css` (design tokens, light and dark) |
| `docs/cs409/` | Rewrite plan and course deliverables |
| `legacy/` | The original Python backend, gateway and deployment files, kept as a porting reference |

## License

Released under the [GNU General Public License, version 2](LICENSE). Third-party dependencies keep their own licenses. Development involved AI coding agents under human-directed requirements and review.
