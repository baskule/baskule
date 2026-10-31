// OTLP span export (src/trace.ts) against a local collector. Run: pnpm test
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

test("spans nest under the caller's traceparent and export as OTLP JSON", async () => {
  const bodies: any[] = [];
  const collector = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    bodies.push({ path: req.url, body: JSON.parse(body) });
    res.end("{}");
  });
  await new Promise<void>((r) => collector.listen(0, "127.0.0.1", r));
  process.env.OTLP_TRACES_URL = `http://127.0.0.1:${(collector.address() as any).port}/v1/traces`;
  const trace = await import(`../src/trace.ts?collector=${Date.now()}`);
  try {
    const caller = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };
    assert.deepEqual(trace.parseTraceparent(`00-${caller.traceId}-${caller.spanId}-01`), caller);
    assert.equal(trace.parseTraceparent("garbage"), undefined);

    const request = trace.startSpan("computerd POST exec", { "baskule.space": "s1" }, { parent: caller, server: true });
    await request.within(() => trace.traced("computer.ensure", { created: true }, async () => {}));
    await assert.rejects(request.within(() => trace.traced("computer.prepare", {}, async () => { throw new Error("mkdir failed"); })));
    request.end();
    await trace.flush();

    assert.equal(bodies[0].path, "/v1/traces");
    const spans = bodies.flatMap((b) => b.body.resourceSpans[0].scopeSpans[0].spans);
    const byName = Object.fromEntries(spans.map((s: any) => [s.name, s]));
    const root = byName["computerd POST exec"];
    assert.equal(root.traceId, caller.traceId);
    assert.equal(root.parentSpanId, caller.spanId);
    assert.equal(root.kind, 2);
    assert.deepEqual(root.attributes, [{ key: "baskule.space", value: { stringValue: "s1" } }]);
    for (const child of ["computer.ensure", "computer.prepare"]) {
      assert.equal(byName[child].traceId, caller.traceId);
      assert.equal(byName[child].parentSpanId, root.spanId);
    }
    assert.deepEqual(byName["computer.prepare"].status, { code: 2, message: "mkdir failed" });
    assert.ok(BigInt(root.endTimeUnixNano) >= BigInt(root.startTimeUnixNano));
  } finally {
    delete process.env.OTLP_TRACES_URL;
    collector.close();
  }
});
