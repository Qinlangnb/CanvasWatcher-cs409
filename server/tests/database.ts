import "dotenv/config";

const DEFAULT_URL = "postgresql://canvaswatcher:canvaswatcher@localhost:5432/canvaswatcher_test";

/** Tests empty this database before every test, so it must never be the development one. */
export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL || DEFAULT_URL;
  const name = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!name.endsWith("_test")) {
    throw new Error(`TEST_DATABASE_URL must name a database ending in "_test" (got "${name}").`);
  }
  return url;
}
