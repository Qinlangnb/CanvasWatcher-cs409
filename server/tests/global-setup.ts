import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { testDatabaseUrl } from "./database.js";

const prismaCli = fileURLToPath(new URL("../node_modules/prisma/build/index.js", import.meta.url));

/** Creates the test database if needed and applies every migration to it. */
export default async function setup(): Promise<void> {
  const url = new URL(testDatabaseUrl());
  const name = decodeURIComponent(url.pathname.slice(1));
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const client = new pg.Client({ connectionString: maintenance.toString() });
  await client.connect();
  try {
    const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [name]);
    if (existing.rowCount === 0) await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
  } finally {
    await client.end();
  }
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url.toString() },
    stdio: ["ignore", "ignore", "inherit"],
  });
}
