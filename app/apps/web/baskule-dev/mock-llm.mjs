// baskule: mock OpenAI-compatible /v1/chat/completions (streaming). No key, no spend.
// Streams a short answer word by word so live streaming is visible in the UI.
import * as NodeHttp from "node:http";

const PORT = Number(process.env.MOCK_LLM_PORT ?? 47702);
const ANSWER =
  "Here is a short answer from the mock model. It streams word by word, so the chat shows partial text while the run is still going.\n\nNothing here costs anything: the platform's dev loop never calls a real model.";

NodeHttp.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", async () => {
    let request = {};
    try {
      request = JSON.parse(body);
    } catch {}
    const system = JSON.stringify(request.messages?.[0] ?? "").slice(0, 400);
    const isTitle = /title|name conversations/i.test(system);
    const chunk = (c) =>
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", created: 0, model: "m", ...c })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    const words = isTitle ? ["Mock chat"] : ANSWER.split(/(?<= )/);
    for (const word of words) {
      res.write(
        chunk({
          choices: [{ index: 0, delta: { role: "assistant", content: word }, finish_reason: null }],
        }),
      );
      if (!isTitle) await new Promise((r) => setTimeout(r, 60));
    }
    res.write(
      chunk({
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 40 },
      }),
    );
    res.end("data: [DONE]\n\n");
  });
}).listen(PORT, "127.0.0.1", () => console.log(`mock llm on ${PORT}`));
