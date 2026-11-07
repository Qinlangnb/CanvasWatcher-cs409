// Measures the API's read endpoints against a large synthetic dataset.
//
//   npm run bench -- [--out results.json]
//
// Uses BENCH_DATABASE_URL, or TEST_DATABASE_URL renamed to canvaswatcher_bench. The database is
// dropped and recreated on every run, so its name must end in "_bench". Nothing leaves this machine:
// the requests go to the app in-process through supertest.
//
// For each endpoint it reports the median wall time of the whole request, and for the slowest SQL
// statement the request ran: the median execution time from EXPLAIN ANALYZE and the scans in its plan.
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";
import { pino } from "pino";
import request from "supertest";
import { createApp } from "../src/app.js";
import { SESSION_COOKIE, createSession } from "../src/auth/sessions.js";
import { loadConfig } from "../src/config.js";
import type { Db } from "../src/db.js";
import { PrismaClient } from "../src/generated/prisma/client.js";
import { createServices } from "../src/services.js";

const RUNS = 9;
const EXPLAIN_RUNS = 5;

/**
 * Ordinary users; one heavy user with several years of data; and one quiet user whose few changes
 * are all old, so they sit far back in the id order (a student who rarely gets changes).
 */
const SIZES = {
  users: 400,
  courses: { normal: 6, heavy: 10 },
  tasksPerCourse: { normal: 10, heavy: 60 },
  filesPerCourse: { normal: 15, heavy: 400 },
  changes: { normal: 300, heavy: 6000, quiet: 50 },
  events: { normal: 120, heavy: 2500 },
};

function benchUrl(): string {
  const fallback = process.env.TEST_DATABASE_URL;
  const url = new URL(process.env.BENCH_DATABASE_URL || (fallback ? fallback.replace(/\/[^/?]+(\?|$)/, "/canvaswatcher_bench$1") : ""));
  const name = decodeURIComponent(url.pathname.slice(1));
  if (!name.endsWith("_bench")) throw new Error(`The benchmark database name must end in "_bench" (got "${name}").`);
  return url.toString();
}

async function recreateDatabase(url: string): Promise<void> {
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    const quoted = `"${name.replaceAll('"', '""')}"`;
    await client.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
    await client.query(`CREATE DATABASE ${quoted}`);
  } finally {
    await client.end();
  }
  const prismaCli = fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url));
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** Set-based inserts. Rows of all users are interleaved in time, as a real sync would leave them. */
async function seed(client: pg.Client): Promise<void> {
  const pick = (sizes: { normal: number; heavy: number }) => `CASE WHEN u.username = 'heavy' THEN ${sizes.heavy} ELSE ${sizes.normal} END`;
  const statements = [
    `INSERT INTO users (id, username, username_key, email, password_hash, updated_at)
       SELECT gen_random_uuid(), name, name, name || '@bench.invalid', 'not-a-password-hash', now()
       FROM (SELECT 'user' || g AS name FROM generate_series(1, ${SIZES.users}) g UNION ALL VALUES ('heavy'), ('quiet')) names`,
    `INSERT INTO canvas_connections (user_id, base_url, token_ciphertext, canvas_user_id, display_name, verified_at, last_synced_at, updated_at)
       SELECT id, 'https://canvas.bench.invalid', 'none', username, username, now(), now(), now() FROM users`,
    `INSERT INTO user_settings (user_id, updated_at) SELECT id, now() FROM users`,
    // The first course of every user is archived.
    `INSERT INTO courses (user_id, canvas_id, course_code, name, html_url, archived_at, last_seen_at, updated_at)
       SELECT u.id, 'c' || c, 'BENCH ' || (100 + c), 'Course ' || c, 'https://canvas.bench.invalid/courses/' || c,
              CASE WHEN c = 1 THEN now() - interval '200 days' END, now(), now()
       FROM users u CROSS JOIN LATERAL generate_series(1, ${pick(SIZES.courses)}) c`,
    // Due dates spread from a year ago to a few months ahead; past work is mostly graded.
    `INSERT INTO tasks (user_id, course_id, canvas_id, title, task_type, due_at, submission_state, updated_at)
       SELECT c.user_id, c.id, 't' || t, 'Assignment ' || t, (ARRAY['homework','exam','project','reading','assignment'])[1 + t % 5],
              now() + ((t - n * 0.8) / n)::float8 * interval '400 days',
              CASE WHEN t < n * 0.75 THEN 'graded' ELSE 'unsubmitted' END, now()
       FROM courses c JOIN users u ON u.id = c.user_id
       CROSS JOIN LATERAL (SELECT ${pick(SIZES.tasksPerCourse)} AS n) sizes
       CROSS JOIN LATERAL generate_series(1, sizes.n) t`,
    `INSERT INTO files (user_id, course_id, canvas_id, display_name, content_type, size_bytes, canvas_updated_at, updated_at)
       SELECT c.user_id, c.id, 'f' || f,
              (ARRAY['Lecture','Slides','Homework','Notes','Syllabus'])[1 + f % 5] || ' ' || f || '.pdf',
              'application/pdf', 1000 + f * 37, now() - random() * interval '700 days', now()
       FROM courses c JOIN users u ON u.id = c.user_id
       CROSS JOIN LATERAL generate_series(1, ${pick(SIZES.filesPerCourse)}) f`,
    // One source item per change keeps the join realistic without modelling repeated edits.
    `CREATE TEMP TABLE planned AS
       SELECT u.id AS user_id, (SELECT c.id FROM courses c WHERE c.user_id = u.id ORDER BY c.id OFFSET (g % ${SIZES.courses.normal}) LIMIT 1) AS course_id,
              g,
              CASE WHEN u.username = 'quiet' THEN now() - interval '600 days' - random() * interval '100 days'
                   ELSE now() - random() * interval '730 days' END AS detected_at
       FROM users u
       CROSS JOIN LATERAL generate_series(1, CASE u.username WHEN 'heavy' THEN ${SIZES.changes.heavy}
                                                             WHEN 'quiet' THEN ${SIZES.changes.quiet}
                                                             ELSE ${SIZES.changes.normal} END) g`,
    `INSERT INTO source_items (user_id, course_id, kind, canvas_id, title, content_hash, content)
       SELECT user_id, course_id, (ARRAY['ASSIGNMENT','FILE','ANNOUNCEMENT']::item_kind[])[1 + g % 3], 's' || g, 'Item ' || g, md5(g::text), '{}'
       FROM planned`,
    `INSERT INTO change_events (user_id, course_id, source_item_id, change_type, fields, summary, before, after, detected_at, read_at)
       SELECT p.user_id, p.course_id, s.id, 'UPDATED', ARRAY['due_at'], 'Due date changed', '{}', '{}', p.detected_at,
              CASE WHEN p.detected_at < now() - interval '14 days' THEN p.detected_at + interval '1 day' END
       FROM planned p JOIN source_items s ON s.user_id = p.user_id AND s.course_id = p.course_id AND s.canvas_id = 's' || p.g
       ORDER BY p.detected_at`,
    // Imported calendars reach two years back.
    `INSERT INTO calendar_events (user_id, title, start_at, end_at, all_day, busy, updated_at)
       SELECT id, 'Lecture ' || e, ts, ts + interval '75 minutes', false, true, now()
       FROM (SELECT u.id, e, date_trunc('hour', now() - interval '730 days' + random() * interval '820 days') AS ts
             FROM users u CROSS JOIN LATERAL generate_series(1, ${pick(SIZES.events)}) e) planned_events`,
    "ANALYZE",
  ];
  for (const sql of statements) await client.query(sql);
}

interface Captured {
  query: string;
  params: unknown[];
}

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

function scans(node: PlanNode, out: string[] = []): string[] {
  if (node["Relation Name"]) {
    out.push(`${node["Node Type"]} ${node["Relation Name"]}${node["Index Name"] ? ` (${node["Index Name"]})` : ""}`);
  }
  for (const child of node.Plans ?? []) scans(child, out);
  return out;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

async function main(): Promise<void> {
  const out = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : undefined;
  const url = benchUrl();
  await recreateDatabase(url);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const started = Date.now();
  await seed(client);
  const counts = (await client.query(
    `SELECT (SELECT count(*) FROM users) users, (SELECT count(*) FROM tasks) tasks, (SELECT count(*) FROM files) files,
            (SELECT count(*) FROM change_events) changes, (SELECT count(*) FROM calendar_events) events`,
  )).rows[0] as Record<string, string>;
  console.log(`Seeded in ${((Date.now() - started) / 1000).toFixed(1)} s:`, counts);

  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: url,
    SESSION_SECRET: "bench-session-secret-0123456789abcdef",
    CREDENTIALS_KEY: Buffer.alloc(32, 1).toString("base64"),
    SYNC_INTERVAL_MINUTES: "0",
    LOG_LEVEL: "silent",
  });
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }), log: [{ emit: "event", level: "query" }] });
  let capture: Captured[] | null = null;
  prisma.$on("query", (event) => capture?.push({ query: event.query, params: JSON.parse(event.params) as unknown[] }));
  const db = prisma as unknown as Db;
  const logger = pino({ level: "silent" });
  const app = createApp({ config, db, logger, services: createServices({ config, db, logger }) });

  const results: Record<string, unknown>[] = [];
  for (const username of ["user1", "heavy", "quiet"]) {
    const user = (await client.query("SELECT id FROM users WHERE username = $1", [username])).rows[0] as { id: string };
    const { token } = await createSession(db, user.id);
    const course = (await client.query("SELECT id FROM courses WHERE user_id = $1 AND archived_at IS NULL ORDER BY id LIMIT 1", [user.id]))
      .rows[0] as { id: number };
    // A cursor halfway down the user's change feed.
    const deep = (
      await client.query(
        `SELECT id FROM change_events WHERE user_id = $1 ORDER BY id DESC
         OFFSET (SELECT count(*) / 2 FROM change_events WHERE user_id = $1) LIMIT 1`,
        [user.id],
      )
    ).rows[0] as { id: number } | undefined;
    const weekFrom = new Date();
    const weekTo = new Date(weekFrom.getTime() + 7 * 86_400_000);
    const paths = [
      "/api/changes?limit=30",
      ...(deep ? [`/api/changes?limit=30&before=${deep.id}`] : []),
      `/api/changes?limit=30&course_id=${course.id}`,
      "/api/changes/unread-count",
      "/api/files",
      "/api/files?q=lecture",
      "/api/tasks?status=all",
      "/api/today",
      `/api/calendar/events?from=${encodeURIComponent(weekFrom.toISOString())}&to=${encodeURIComponent(weekTo.toISOString())}`,
      "/api/courses",
    ];

    for (const path of paths) {
      const get = () => request(app).get(path).set("Cookie", `${SESSION_COOKIE}=${token}`);
      const first = await get();
      if (first.status !== 200) throw new Error(`${path} returned ${first.status}: ${JSON.stringify(first.body)}`);
      const wall: number[] = [];
      for (let run = 0; run < RUNS; run += 1) {
        const t0 = performance.now();
        await get();
        wall.push(performance.now() - t0);
      }
      capture = [];
      await get();
      const statements = capture as Captured[];
      capture = null;

      let slowest = { ms: -1, scans: [] as string[], sql: "" };
      for (const statement of statements) {
        if (!/^\s*SELECT/i.test(statement.query) || /FROM "public"\."sessions"/.test(statement.query)) continue;
        const times: number[] = [];
        let plan: PlanNode | null = null;
        for (let run = 0; run < EXPLAIN_RUNS; run += 1) {
          const explained = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${statement.query}`, statement.params);
          const row = (explained.rows[0] as { "QUERY PLAN": [{ Plan: PlanNode; "Execution Time": number }] })["QUERY PLAN"][0];
          times.push(row["Execution Time"]);
          plan = row.Plan;
        }
        const ms = median(times);
        if (ms > slowest.ms) slowest = { ms, scans: plan ? scans(plan) : [], sql: statement.query };
      }
      const result = {
        user: username,
        path: path.replace(/from=[^&]+&to=[^&]+/, "from=…&to=…").replace(/=\d+/g, "=…"),
        rows: Array.isArray(first.body) ? first.body.length : Array.isArray(first.body.items) ? first.body.items.length : null,
        request_ms: Number(median(wall).toFixed(2)),
        sql_ms: Number(slowest.ms.toFixed(3)),
        scans: slowest.scans,
        sql: slowest.sql,
      };
      results.push(result);
      console.log(
        `${username.padEnd(6)} ${result.path.padEnd(44)} request ${result.request_ms.toFixed(1).padStart(6)} ms  sql ${result.sql_ms.toFixed(2).padStart(7)} ms  ${result.scans.join("; ")}`,
      );
    }
  }

  if (out) writeFileSync(out, JSON.stringify({ counts, results }, null, 2));
  await prisma.$disconnect();
  await client.end();
}

await main();
