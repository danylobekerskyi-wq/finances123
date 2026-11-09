import { describe, expect, it, vi } from "vitest";
import type { NewsGateContext } from "../src/newsGate.js";
import { OpenAIWebSearchNewsGate } from "../src/openaiNewsGate.js";

const NOW = Date.parse("2026-08-14T20:00:00.000Z");
const context: NewsGateContext = {
  pair: "BTC/USD",
  signalCapturedAt: "2026-08-14T19:59:55.000Z",
  setup15m: "RANGE_REVERSAL",
  trigger5m: true,
};

function apiPayload(
  status: "clear" | "blocked" | "unknown",
  sourceUrls: string[],
) {
  return {
    output: [
      {
        type: "web_search_call",
        action: {
          sources: sourceUrls.map((url) => ({ type: "url", url })),
        },
      },
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              status,
              note:
                status === "clear"
                  ? "No material event risk found"
                  : "Material event risk found",
              blockingEvents:
                status === "blocked" ? ["High-impact event"] : [],
            }),
          },
        ],
      },
    ],
  };
}

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("OpenAIWebSearchNewsGate", () => {
  it("forces live web search and accepts clear only with two HTTPS sources", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      response(
        apiPayload("clear", [
          "https://example.com/crypto",
          "https://example.org/calendar",
        ]),
      ),
    );
    const gate = new OpenAIWebSearchNewsGate({
      apiKey: "test-secret",
      model: "gpt-5.4-mini",
      clock: () => NOW,
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(gate.getNewsStatus(context)).resolves.toMatchObject({
      status: "clear",
      checkedAt: "2026-08-14T20:00:00.000Z",
      sourceUrls: [
        "https://example.com/crypto",
        "https://example.org/calendar",
      ],
    });
    const request = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(request.tools).toEqual([
      { type: "web_search", external_web_access: true },
    ]);
    expect(request.tool_choice).toBe("required");
    expect(request.include).toContain("web_search_call.action.sources");
    expect(request.text.format.type).toBe("json_schema");
  });

  it("fails closed when a clear result lacks enough sources", async () => {
    const gate = new OpenAIWebSearchNewsGate({
      apiKey: "test-secret",
      model: "gpt-5.4-mini",
      clock: () => NOW,
      fetchImpl: vi.fn(async () =>
        response(apiPayload("clear", ["https://example.com/only-one"])),
      ) as typeof fetch,
    });
    await expect(gate.getNewsStatus(context)).resolves.toMatchObject({
      status: "unknown",
    });
  });

  it("blocks entries when current search finds material event risk", async () => {
    const gate = new OpenAIWebSearchNewsGate({
      apiKey: "test-secret",
      model: "gpt-5.4-mini",
      clock: () => NOW,
      fetchImpl: vi.fn(async () =>
        response(apiPayload("blocked", ["https://example.com/event"])),
      ) as typeof fetch,
    });
    await expect(gate.getNewsStatus(context)).resolves.toMatchObject({
      status: "blocked",
      note: expect.stringContaining("High-impact event"),
    });
  });

  it("fails closed on an API error or when called without a signal", async () => {
    const fetchImpl = vi.fn(async () => response({}, 500));
    const gate = new OpenAIWebSearchNewsGate({
      apiKey: "test-secret",
      model: "gpt-5.4-mini",
      clock: () => NOW,
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(gate.getNewsStatus(context)).resolves.toMatchObject({
      status: "unknown",
      note: expect.stringContaining("HTTP 500"),
    });
    await expect(gate.getNewsStatus()).resolves.toMatchObject({
      status: "unknown",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
