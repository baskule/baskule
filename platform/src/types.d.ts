declare module "*.sql" {
  const sql: string;
  export default sql;
}
declare module "*/migrations/migrations.js" {
  const m: { journal: unknown; migrations: Record<string, string> };
  export default m;
}
