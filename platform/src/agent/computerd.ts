// Thin client of computerd v2 (architecture E4; contract: computerd/v2/README.md) for one space.
export interface ExecSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** base64 */
  stdin?: string;
  id?: string;
  timeoutMs?: number;
}

export class Computerd {
  constructor(
    readonly url: string,
    private readonly token: string,
    readonly spaceId: string,
    private readonly fetcher: typeof fetch = (i, init) => fetch(i, init),
  ) {}

  get configured(): boolean {
    return Boolean(this.url && this.token);
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, ...extra };
  }

  private space(path: string): string {
    return `${this.url}/v1/spaces/${encodeURIComponent(this.spaceId)}${path}`;
  }

  /** Starts an exec; the response body is the NDJSON frame stream. */
  exec(spec: ExecSpec, signal?: AbortSignal): Promise<Response> {
    return this.fetcher(this.space("/exec"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(spec),
      signal,
    });
  }

  /** Runs a command to completion and collects its output (small outputs only). */
  async run(argv: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
    const res = await this.exec({ argv, ...opts });
    if (!res.ok) return { code: null, stdout: "", stderr: "", error: `computerd exec answered ${res.status}: ${(await res.text()).slice(0, 200)}` };
    let stdout = "";
    let stderr = "";
    let code: number | null = null;
    let error: string | undefined;
    for (const line of (await res.text()).split("\n")) {
      if (!line.trim()) continue;
      const f = JSON.parse(line) as { t: string; d?: string; code?: number; msg?: string };
      if (f.t === "o") stdout += Buffer.from(f.d ?? "", "base64").toString();
      else if (f.t === "e") stderr += Buffer.from(f.d ?? "", "base64").toString();
      else if (f.t === "x") code = f.code ?? null;
      else if (f.t === "err") error = f.msg;
    }
    return { code, stdout, stderr, ...(error ? { error } : {}) };
  }

  async kill(id: string, signal = "TERM", graceMs = 3000): Promise<unknown> {
    const res = await this.fetcher(this.space("/kill"), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ id, signal, graceMs }),
      signal: AbortSignal.timeout(15_000),
    });
    return res.json().catch(() => ({ status: res.status }));
  }

  async status(): Promise<unknown> {
    const res = await this.fetcher(this.space("/computer"), { headers: this.headers(), signal: AbortSignal.timeout(5_000) });
    return res.ok ? res.json() : { error: `computerd ${res.status}` };
  }
}
