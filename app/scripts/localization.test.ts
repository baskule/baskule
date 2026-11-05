import { expect, it, vi } from "vite-plus/test";
import {
  placeholders,
  translateBatch,
  translateWithRetries,
  validateTranslation,
} from "./localization.ts";

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

it.each([false, true])(
  "keeps valid translations after batch retries and fails if individual retries stay invalid (%s)",
  async (permanentlyInvalid) => {
    vi.stubEnv("TRANSLATION_API_KEY", "test-key");
    using _warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const entries: [string, { text: string; locations: string[] }][] = [
        [
          "Closed {{value1}} pull request{{value2}}",
          { text: "Closed {{value1}} pull request{{value2}}", locations: [] },
        ],
        ["Hello {{name}}", { text: "Hello {{name}}", locations: [] }],
        ["Goodbye", { text: "Goodbye", locations: [] }],
      ];
      let individualAttempts = 0;
      const request = vi.fn<typeof fetch>(async (_url, init) => {
        const body: { messages: { content: string }[] } = JSON.parse(String(init?.body));
        const messages: { id: string; english: string }[] = JSON.parse(body.messages[1]!.content);
        const translated = Object.fromEntries(
          messages.map(({ id, english }) => {
            if (english === "Closed {{value1}} pull request{{value2}}") {
              if (messages.length === 1) individualAttempts++;
              return [
                id,
                messages.length > 1 || permanentlyInvalid || individualAttempts < 3
                  ? "Demande {{value1}} fermée"
                  : "Demande{{value2}} {{value1}} fermée",
              ];
            }
            return [id, english === "Hello {{name}}" ? "Bonjour {{name}}" : "Au revoir"];
          }),
        );
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: JSON.stringify(translated) } }],
          }),
        );
      });
      const catalog = { Existing: "Existant" };
      const result = translateWithRetries(
        "fr",
        entries,
        "context",
        catalog,
        (locale, batch, context) => translateBatch(locale, batch, context, request),
      );
      if (permanentlyInvalid) {
        await expect(result).rejects.toThrow("Changed interpolation placeholders");
      } else {
        await expect(result).resolves.toBeUndefined();
      }
      expect(catalog).toEqual({
        Existing: "Existant",
        "Hello {{name}}": "Bonjour {{name}}",
        Goodbye: "Au revoir",
        ...(permanentlyInvalid
          ? {}
          : {
              "Closed {{value1}} pull request{{value2}}": "Demande{{value2}} {{value1}} fermée",
            }),
      });
      expect(individualAttempts).toBe(3);
      expect(request).toHaveBeenCalledTimes(8);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);
