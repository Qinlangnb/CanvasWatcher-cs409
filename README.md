# CanvasWatcher / Academic Watcher — CS409

> **CS409 fork.** This repository is the course-project fork of [CanvasWatcher](https://github.com/Qinlangnb/CanvasWatcher). The backend is being rewritten as a single multi-user REST API in **TypeScript on Node.js** (Express, PostgreSQL, Prisma). The original Python services live in [`legacy/`](legacy/README.md) only as a porting reference; they are not built, tested or deployed. See the [rewrite plan](docs/cs409/REWRITE_PLAN.zh-CN.md).

[中文说明](README.zh-CN.md) · [Rewrite plan](docs/cs409/REWRITE_PLAN.zh-CN.md) · [GPL-2.0](LICENSE)

CanvasWatcher collects course materials, deadlines, tasks, and meaningful changes from Canvas and supported course sites. It offers a Today planner, file history, calendar imports, and optional AI assistance. Source synchronization is read-only.

![Today dashboard with synthetic courses and tasks](docs/screenshots/today-demo.png)

*A screenshot of the original application using synthetic demo data.*

## Rewrite status

| Area | State |
| --- | --- |
| Accounts and sessions (`/api/users`, `/api/sessions`) | Done, with tests |
| Courses, assignments, tasks, Canvas sync | Not started; still in `legacy/backend` |
| Frontend | Unchanged React app; its pages still call the legacy API paths |

### API so far

| Method and path | Purpose | Success |
| --- | --- | --- |
| `GET /api/health` | Database reachability | 200 |
| `POST /api/users` | Create an account and sign in | 201 |
| `GET /api/users/me` | The signed-in user | 200 |
| `PUT /api/users/me/password` | Change the password; signs out other devices | 204 |
| `POST /api/sessions` | Sign in with username or email | 201 |
| `DELETE /api/sessions/current` | Sign out this browser | 204 |

Errors are JSON: `{ "detail": "<sentence for the user>", "code": "<MACHINE_CODE>" }`. Validation errors return 422 with `detail` as a list of `{ loc, msg }`. Sessions use an httpOnly cookie; state-changing requests need an allowed `Origin` and, once signed in, the `X-AW-CSRF` header copied from the `aw_csrf` cookie.

## Run the whole stack

Install Docker Desktop (or Docker Engine with Compose v2), then:

```sh
cp .env.example .env    # then set SESSION_SECRET to 32+ random characters
docker compose up -d --build
```

Open `http://localhost:8080`. nginx serves the frontend and forwards `/api` to the API container; the API port is not published. PostgreSQL listens on `127.0.0.1:5432` only.

## Develop

Requires Node.js 22.12 or newer.

```sh
docker compose up -d db          # PostgreSQL only
cd server
cp .env.example .env             # then set SESSION_SECRET
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
| `frontend/` | React and TypeScript interface, served by nginx in Compose |
| `docs/cs409/` | Rewrite plan and course deliverables |
| `legacy/` | The original Python backend, gateway and deployment files, kept as a porting reference |

## License

Released under the [GNU General Public License, version 2](LICENSE). Third-party dependencies keep their own licenses. Development involved AI coding agents under human-directed requirements and review.
