import { execSync } from "node:child_process";

/** With TEST_DATABASE_URL set, applies migrations to that (throwaway) database before the DB tests. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  process.env.DATABASE_URL = url;
  execSync("npx prisma migrate reset --force --skip-seed --skip-generate", { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
}
