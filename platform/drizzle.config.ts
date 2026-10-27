import { defineConfig } from "drizzle-kit";
export default defineConfig({
  dialect: "sqlite",
  driver: "durable-sqlite",
  schema: ["./src/control/schema/auth.ts", "./src/control/schema/app.ts"],
  out: "./src/control/migrations",
});
