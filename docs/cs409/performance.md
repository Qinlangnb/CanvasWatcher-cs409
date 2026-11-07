# Backend performance: indexes and pagination (week 4)

This page records what was measured, what changed because of it, and what did not change. Every number below
comes from the two benchmark runs described here. Nothing is estimated or projected.

## How it was measured

`server/bench/queries.ts` (run with `npm run bench`) does the following:

1. Drops and recreates a scratch database whose name must end in `_bench`. By default this is
   `TEST_DATABASE_URL` with the database renamed to `canvaswatcher_bench`. It then applies every migration.
2. Seeds synthetic data with `generate_series`. Row ids are interleaved across users, as they would be after
   months of syncing many accounts at once.

   | Users | Tasks | Files | Change events | Calendar events |
   |---:|---:|---:|---:|---:|
   | 402 | 24,660 | 40,090 | 126,050 | 50,620 |

   The 402 users fall into three groups:

   - **400 ordinary users:** 6 courses, 10 tasks and 15 files per course, 300 changes and 120 events each.
   - **`heavy`:** 10 courses, 60 tasks and 400 files per course, 6,000 changes and 2,500 events.
   - **`quiet`:** 50 changes, all 600–700 days old. They sit far back in id order, like a student whose courses
     rarely change.
3. Sends real `GET` requests to the app in-process through supertest, using a session cookie for each of
   `user1`, `heavy` and `quiet`. Nothing leaves the machine.
4. For each endpoint it reports two figures:
   - **Request:** the median wall time of the whole request over 9 runs. This includes Express, Prisma, JSON
     encoding and the session lookup.
   - **SQL:** the slowest SQL statement the request ran, re-run 5 times with
     `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. The median execution time and the scans in its plan are shown.

| Setting | Value |
|---|---|
| Machine | Intel Core Ultra 5 250K Plus, Windows 11 |
| Database | PostgreSQL 16.15 (`postgres:16-alpine`) in Docker Desktop 29.6.2 |
| Runtime | Node 24.18.0 |

These are small, single-machine timings. Even the cheapest requests take 5–10 ms end to end, so the SQL
column shows the effect of an index more clearly than the request column.

Before is the week 3 server code (`517e146`) with the benchmark script added. After is the week 4 change.
Both runs used the same seed sizes. The data is random, so row-level details differ slightly between runs.

## What changed

### 1. Change feed indexes

The change feed (`GET /api/changes`) is ordered by `id DESC` and pages with `before=<id>`. The week 2
migration (`canvas_sync`) indexed `change_events` on `(user_id, detected_at)` and `(course_id, detected_at)`, but no query orders or
filters by `detected_at`. As a result, Postgres read the feed by walking the primary key backwards and discarding other users' rows.

The week 4 migration (`20261107025959_week4_demo_accounts_feed_indexes`) replaces them with
`(user_id, id)` and `(course_id, id)`, which match the queries. It keeps `(user_id, read_at)` for the unread
count.

| User | Request | SQL before | SQL after | Plan before → after |
|---|---|---:|---:|---|
| user1 | `/api/changes?limit=30` | 1.47 ms | 0.10 ms | pkey backward scan → `change_events_user_id_id_idx` |
| user1 | `…&before=<halfway id>` | 1.32 ms | 0.07 ms | pkey backward scan → `change_events_user_id_id_idx` |
| quiet | `/api/changes?limit=30` | 8.87 ms | 0.07 ms | pkey backward scan → `change_events_user_id_id_idx` |
| quiet | `…&before=<halfway id>` | 0.83 ms | 0.41 ms | Bitmap Heap Scan in both runs |
| heavy | `/api/changes?limit=30` | 0.13 ms | 0.17 ms | pkey backward scan in both runs |
| heavy | `…&before=<halfway id>` | 0.14 ms | 0.11 ms | pkey backward scan in both runs |

For the `quiet` user, page 1 took 18.9 ms per request before and 7.3 ms after. The old plan scanned past
almost all 126,050 changes to find their 50 old ones.

The old plan was already cheap for `heavy`, whose changes are everywhere in id order, and Postgres still
picks it. Their 0.13 → 0.17 ms is run-to-run noise. The `quiet` deep page used the same bitmap plan both times,
so its 0.83 → 0.41 ms is not an effect of the new index.

### 2. Cursor pagination for `GET /api/files`

Before, the files list returned up to 500 rows in one response. Now it returns `limit` rows (default 50, at most
200) plus `next_cursor`.

The cursor is an opaque keyset `(canvas_updated_at, id)` that follows the list order: newest first, unknown
times last. Pages stay stable while files are added or removed. The Files page and the course Files tab load
more with a "Load more files" button.

| User | Request | Request before | Request after | SQL before | SQL after |
|---|---|---:|---:|---:|---:|
| heavy (4,000 files) | `/api/files` | 16.9 ms (500 rows) | 10.2 ms (50 rows) | 1.93 ms | 1.58 ms |
| heavy | `/api/files?q=lecture` | 17.3 ms (500 rows) | 9.7 ms (50 rows) | 2.00 ms | 1.69 ms |
| user1 | `/api/files` | 10.4 ms (75 rows) | 12.4 ms (50 rows) | 0.46 ms | 0.62 ms |

Almost all of the gain for `heavy` comes from encoding and sending 50 rows instead of 500. The SQL is about the
same because both plans are a Bitmap Heap Scan on `files` followed by a sort of all the user's matching files.
`LIMIT` cannot stop the sort early without an index in list order.

At 1.6 ms for a user with 4,000 files, a third index on `files` was not added. Revisit this if real accounts get
much larger. For `user1`, whose list is short either way, the small differences are noise.

## What did not change

These were measured in both runs and stayed within noise, so they were left alone:

| User | Request | SQL before | SQL after |
|---|---|---:|---:|
| heavy | `/api/changes?limit=30&course_id=…` | 1.57 ms | 1.57 ms |
| heavy | `/api/changes/unread-count` | 0.47 ms | 0.42 ms |
| heavy | `/api/tasks?status=all` | 0.85 ms | 0.81 ms |
| heavy | `/api/today` | 0.63 ms | 0.67 ms |
| heavy | `/api/calendar/events?from=…&to=…` (2 weeks) | 0.30 ms | 0.30 ms |
| heavy | `/api/courses` | 0.65 ms | 0.54 ms |

The per-course feed still uses a Bitmap Heap Scan on `change_events` after the change, even with the new
`(course_id, id)` index. For `heavy`, about 600 rows per course are fetched and sorted. At 1.6 ms it was not
worth forcing a different plan.

`tasks` and `files` lists join `courses` with a sequential scan. The table has a few thousand rows here, and
Postgres prefers that to an index lookup.

## Rerunning

You need Postgres from `docker compose up -d db` and `server/.env` with `TEST_DATABASE_URL`. Then:

```bash
cd server
npm run bench -- --out bench-results.json
```

Seeding takes about 10 seconds. The run prints one line per user and endpoint. With `--out` it also writes
the full results, including the SQL text and plan summary. The scratch database is left in place for
inspection and is recreated on the next run.
