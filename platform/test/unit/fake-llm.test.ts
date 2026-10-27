// @ts-nocheck plain JS module under test
import { describe, expect, it } from "vitest";
import { plan, createServer } from "../../dev/fake-llm/server.mjs";

const user = (content: unknown) => ({ role: "user", content });

describe("fake LLM", () => {
  it("scripts text, tool sequences and attachments deterministically", () => {
    expect(plan({ messages: [user("hi [[fake:text Hello there]]")] }).text).toBe("Hello there");
    expect(plan({ messages: [user("[[fake:long 3]]")] }).text).toBe("word1 word2 word3");
    const tools = "[[fake:tool bash {\"command\":\"ls\"}]] [[fake:tool read {\"path\":\"a\"}]]";
    expect(plan({ messages: [user(tools)] }).toolCall).toEqual({ name: "bash", arguments: '{"command":"ls"}' });
    expect(plan({ messages: [user(tools), { role: "assistant" }, { role: "tool", content: "x" }] }).toolCall.name).toBe("read");
    expect(plan({ messages: [user(tools), { role: "tool", content: "x" }, { role: "tool", content: "y" }] }).text).toBe("Done: bash=x | read=y");
    const att = user([{ type: "text", text: "see" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA" } }, { type: "file", file: { file_data: "data:application/pdf;base64,AA" } }]);
    expect(plan({ messages: [att] }).text).toBe("Fake answer: see [attachments: image/png x1, application/pdf x1]");
    expect(plan({ messages: [user("[[fake:error 429]]")] }).error).toBe(429);
    expect(plan({ messages: [{ role: "system", content: "[[fake:text from system]]" }, user("q")] }).text).toBe("from system");
  });

  it("streams SSE chunks that reassemble to the scripted text", async () => {
    const srv = createServer();
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
    const port = (srv.address() as { port: number }).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        body: JSON.stringify({ stream: true, stream_options: { include_usage: true }, messages: [user("[[fake:text one two  three]] [[fake:delay 0]]")] }),
      });
      const lines = (await res.text()).split("\n\n").filter(Boolean);
      expect(lines.at(-1)).toBe("data: [DONE]");
      const chunks = lines.slice(0, -1).map((l) => JSON.parse(l.slice(6)));
      expect(chunks.map((c) => c.choices[0]?.delta?.content ?? "").join("")).toBe("one two  three");
      expect(chunks.at(-1).usage.total_tokens).toBeGreaterThan(0);
      const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
      expect(models.data.map((m: { id: string }) => m.id)).toContain("fake-model");
    } finally {
      srv.close();
    }
  });
  it("reports Mistral-style terminal usage without an OpenAI stream option", async () => {
    const srv = createServer();
    await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
    try {
      const res = await fetch(`http://127.0.0.1:${srv.address().port}/v1/chat/completions`, {
        method: "POST", body: JSON.stringify({ stream: true, messages: [user("[[fake:text billed]] [[fake:delay 0]]")] }),
      });
      const chunks = (await res.text()).split("\n\n").filter(s => s.startsWith("data: {")).map(s => JSON.parse(s.slice(6)));
      expect(chunks.at(-1).choices[0].finish_reason).toBe("stop");
      expect(chunks.at(-1).usage.prompt_tokens).toBeGreaterThan(0);
      expect(chunks.at(-1).usage.completion_tokens).toBeGreaterThan(0);
    } finally { srv.close(); }
  });

});
