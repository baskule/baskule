// Minimal stand-in for `cloudflare:workers` under vitest (Node).
export class DurableObject<E = unknown> {
  constructor(public ctx: unknown, public env: E) {}
}
