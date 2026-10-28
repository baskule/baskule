import { expect, it, vi } from "vite-plus/test";
import { placeholders, translateBatch, validateTranslation } from "./localization.ts";

it("accepts reordered placeholders but rejects missing, duplicated, or broken placeholders", () => {
  expect(placeholders("{{name}} has {{count}} files")).toEqual(["count", "name"]);
  expect(() => validateTranslation("{{name}}: {{count}}", "{{count}} : {{name}}")).not.toThrow();
  for (const bad of [
    "{{name}}",
    "{{name}} {{count}} {{count}}",
    "{{name}} {{count}} {{broken",
    "",
    null,
  ]) {
    expect(() => validateTranslation("{{name}}: {{count}}", bad)).toThrow();
  }
  expect(() => validateTranslation("Sign in", "<script>signIn()</script>")).toThrow();
});

it("sends product and source context and validates the exact set of generated messages", async () => {
  vi.stubEnv("TRANSLATION_API_KEY", "test-key");
  try {
    const entries: [string, { text: string; locations: string[] }][] = [
      [
        "Hello {{name}}",
        {
          text: "Hello {{name}}",
          locations: ["LoginView.tsx:12 (LoginView)"],
        },
      ],
    ];
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: { content: JSON.stringify({ m0: "Bonjour {{name}}" }) },
            },
          ],
        }),
      ),
    );
    expect(await translateBatch("fr", entries, "Baskule product context", request)).toEqual({
      "Hello {{name}}": "Bonjour {{name}}",
    });
    const body = JSON.parse(String(request.mock.calls[0]?.[1]?.body));
    expect(body.messages[0].content).toContain("Baskule product context");
    expect(body.messages[1].content).toContain("LoginView.tsx:12 (LoginView)");
    expect(Object.keys(body.response_format.json_schema.schema.properties)).toEqual(["m0"]);
    request.mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ finish_reason: "stop", message: { content: '{"extra":"wrong"}' } }],
        }),
      ),
    );
    await expect(translateBatch("fr", entries, "context", request)).rejects.toThrow(
      "changed the requested keys",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});

it("fails closed on truncated output and does not echo a provider error body", async () => {
  vi.stubEnv("TRANSLATION_API_KEY", "private-test-key");
  try {
    const request = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("private-test-key", { status: 401 }));
    await expect(translateBatch("fr", [], "context", request)).rejects.toThrow(
      "Translation request failed (HTTP 401)",
    );
    request.mockResolvedValue(
      new Response(
        JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{}" } }] }),
      ),
    );
    await expect(translateBatch("fr", [], "context", request)).rejects.toThrow(
      "Incomplete translation response",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
