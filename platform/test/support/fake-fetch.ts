// A recorded-response fetcher: routes match an exact URL or, ending in "*", a URL prefix. Unmatched URLs answer 404.
export interface Seen { url: string; method: string; headers: Record<string, string>; body: string }
type Answer = Response | ((seen: Seen) => Response | Promise<Response>);

export function fakeFetch(routes: Record<string, Answer>) {
  const seen: Seen[] = [];
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const request: Seen = { url, method: init.method ?? "GET", headers: Object.fromEntries(new Headers(init.headers)), body: typeof init.body === "string" ? init.body : "" };
    seen.push(request);
    const key = Object.keys(routes).find(route => route === url || (route.endsWith("*") && url.startsWith(route.slice(0, -1))));
    if (!key) return new Response("not found", { status: 404 });
    const answer = routes[key]!;
    return typeof answer === "function" ? answer(request) : answer.clone();
  }) as typeof fetch;
  return { fetcher, seen, routes };
}

export const ok = (value: unknown, init: ResponseInit = {}) => typeof value === "string" ? new Response(value, init) : Response.json(value, init);
