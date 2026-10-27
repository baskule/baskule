// Only for `auth generate` (Better Auth CLI): same plugins as src/control/auth.ts, over bun:sqlite.
// Regenerate on every Better Auth upgrade:  bunx --bun auth@1.7.12 generate --config scripts/auth-gen/auth-cli.ts --output scripts/auth-gen/auth-schema.generated.ts --yes
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, bearer } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
const db = drizzle(new Database(":memory:"));
export const auth = betterAuth({
  secret: "generate-only-0123456789abcdef0123456789abcdef",
  emailAndPassword: { enabled: true },
  telemetry: { enabled: false },
  plugins: [admin(), bearer()],
  database: drizzleAdapter(db, { provider: "sqlite" }),
});
