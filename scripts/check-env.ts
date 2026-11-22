/** Checks that production settings are present before go-live. Prints names only, never values. */
const problems: string[] = [];
const need = (name: string, ok: (value: string) => boolean, why: string) => {
  const value = process.env[name];
  if (!value || !ok(value)) problems.push(`${name}: ${why}`);
};

need("DATABASE_URL", (v) => v.startsWith("postgres"), "PostgreSQL connection string for THIS platform's own database");
need("AUTH_SECRET", (v) => v.length >= 32 && !v.startsWith("dev-only"), "random string of 32+ characters (openssl rand -base64 48)");
need("ANTHROPIC_API_KEY", (v) => v.startsWith("sk-ant-"), "Claude API key from a separate Console workspace for client agents");
need("APP_URL", (v) => v.startsWith("https://"), "public https URL of the platform");

if (problems.length) {
  console.error("Missing or invalid settings:\n- " + problems.join("\n- "));
  process.exitCode = 1;
} else {
  console.log("Environment OK.");
}
