export function withCacheControl(response: Response, policy: string): Response {
  // Reconstructing a WebSocket upgrade would discard its runtime-owned socket.
  if (response.status === 101) return response;
  const headers = new Headers(response.headers);
  headers.set("cache-control", policy);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
