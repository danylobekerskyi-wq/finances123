import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import type { LiveStatusProvider } from "./liveTrader.js";
import type { ShadowStatusProvider } from "./shadowBroker.js";
import { TradingService } from "./tradingService.js";
import { SUPPORTED_PAIRS } from "./types.js";

function success(value: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
  };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : "Unexpected tool error";
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

async function safeTool(
  operation: () => Promise<Record<string, unknown>> | Record<string, unknown>,
): Promise<CallToolResult> {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

export function createTradingMcpServer(
  service: TradingService,
  liveStatus?: LiveStatusProvider,
  shadowStatus?: ShadowStatusProvider,
): McpServer {
  const server = new McpServer(
    { name: "crypto-trading-mcp", version: "0.3.1" },
    {
      instructions:
        "Kraken USD spot day-trading tools for the configured supported pairs. Never describe a WAIT or NO_TRADE result as a trade signal. A BUY_SETUP_CONFIRMED result is valid only until signalExpiresAt. place_paper_trade is simulated. Shadow trades use a separate ledger and never count toward the main paper target. validate_kraken_order always sends validate=true. Expanded pairs are paper-enabled; guarded live automation remains limited to BTC/USD and ETH/USD. MCP intentionally exposes live status but no direct live-order tool.",
    },
  );

  server.registerTool(
    "scan_market",
    {
      title: "Scan a supported USD day-trade setup",
      description:
        "Fetch closed Kraken 1M/5M/15M/1H candles and a fresh Coinbase Exchange level-1 best bid/ask, then confirm a spot-long breakout when the latest closed 1M, 5M, or 15M candle finishes above its resistance. Supply a current news/macro check; otherwise the result intentionally blocks execution.",
      inputSchema: {
        pair: z.enum(SUPPORTED_PAIRS).describe("Supported Kraken USD spot pair"),
        news_status: z
          .enum(["clear", "unknown", "blocked"])
          .optional()
          .describe("blocked when material news/macro event risk is present"),
        news_checked_at: z
          .string()
          .optional()
          .describe("ISO-8601 time of the latest news/macro check"),
      },
      outputSchema: {
        signalId: z.string().nullable(),
        result: z.record(z.string(), z.unknown()),
        reference: z.record(z.string(), z.unknown()).nullable(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) =>
      safeTool(async () => {
        const response = await service.scan({
          pair: input.pair,
          newsStatus: input.news_status,
          newsCheckedAt: input.news_checked_at,
        });
        return response as unknown as Record<string, unknown>;
      }),
  );

  server.registerTool(
    "calculate_trade_plan",
    {
      title: "Calculate a risk-capped long plan",
      description:
        "Calculate units, position value, stop loss, minimum 2R target, and estimated Kraken taker fees/slippage for a USD spot-long plan. This never places an order.",
      inputSchema: {
        balance_cad: z.number().min(10).max(500),
        entry_cad: z.number().positive(),
        stop_cad: z.number().positive(),
      },
      outputSchema: {
        plan: z.record(z.string(), z.unknown()),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) =>
      safeTool(() => ({
        plan: service.calculatePlan({
          balanceCad: input.balance_cad,
          entry: input.entry_cad,
          stop: input.stop_cad,
        }),
      })),
  );

  server.registerTool(
    "place_paper_trade",
    {
      title: "Open a simulated paper trade",
      description:
        "Open one simulated USD spot position from a non-expired signal_id returned by scan_market. This mutates only the local paper ledger and cannot place a live exchange order.",
      inputSchema: {
        signal_id: z.string().uuid(),
        confirm_paper_only: z
          .literal(true)
          .describe("Must be true to acknowledge that this is simulation only"),
      },
      outputSchema: {
        mode: z.literal("paper"),
        execution: z.record(z.string(), z.unknown()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ signal_id }) =>
      safeTool(async () => ({
        mode: "paper",
        execution: await service.placePaperTrade(signal_id),
      })),
  );

  server.registerTool(
    "get_paper_portfolio",
    {
      title: "Get the simulated portfolio",
      description:
        "Return paper cash, position, equity, P&L, and daily risk-stop status. If an open position crossed its stop or target, it is closed in the simulated ledger.",
      outputSchema: {
        mode: z.literal("paper"),
        portfolio: z.record(z.string(), z.unknown()),
        autoClosedTrade: z.record(z.string(), z.unknown()).nullable(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () =>
      safeTool(async () => ({
        mode: "paper",
        ...(await service.getPaperPortfolio()),
      })),
  );

  server.registerTool(
    "get_paper_test_progress",
    {
      title: "Get progress toward the paper-trade target",
      description:
        "Return genuinely closed paper trades, remaining trades, wins, losses, win rate, P&L, average R, and target status. WAIT and NO_TRADE scans are never counted.",
      outputSchema: {
        mode: z.literal("paper"),
        progress: z.record(z.string(), z.unknown()),
        portfolio: z.record(z.string(), z.unknown()),
        autoClosedTrade: z.record(z.string(), z.unknown()).nullable(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () =>
      safeTool(async () => ({
        mode: "paper",
        ...(await service.getPaperTestProgress()),
      })),
  );

  server.registerTool(
    "close_paper_trade",
    {
      title: "Close the simulated position",
      description:
        "Manually close the current simulated position at the latest Kraken bid with configured slippage and fees. No live order is sent.",
      inputSchema: {
        confirm_paper_close: z.literal(true),
      },
      outputSchema: {
        mode: z.literal("paper"),
        closedTrade: z.record(z.string(), z.unknown()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async () =>
      safeTool(async () => ({
        mode: "paper",
        closedTrade: await service.closePaperTrade(),
      })),
  );

  server.registerTool(
    "validate_kraken_order",
    {
      title: "Validate a Kraken limit order without trading",
      description:
        "Call Kraken AddOrder with validate=true. This tool hardcodes validation mode and cannot submit a live order. Disabled unless explicitly configured with environment variables.",
      inputSchema: {
        pair: z.enum(SUPPORTED_PAIRS),
        side: z.enum(["buy", "sell"]),
        volume: z.number().positive(),
        price_cad: z.number().positive(),
        acknowledge_validate_only: z.literal(true),
      },
      outputSchema: {
        validateOnly: z.literal(true),
        exchangeResponse: z.unknown(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) =>
      safeTool(async () => ({
        validateOnly: true,
        exchangeResponse: await service.validateKrakenOrder({
          pair: input.pair,
          side: input.side,
          volume: input.volume,
          price: input.price_cad,
        }),
      })),
  );

  server.registerTool(
    "get_shadow_status",
    {
      title: "Get the separate shadow portfolio",
      description:
        "Return simulated trades captured while the main paper daily protection blocked entries. The shadow ledger is separate and never changes main paper progress, cash, risk limits, or any live account.",
      outputSchema: {
        enabled: z.boolean(),
        status: z.record(z.string(), z.unknown()).nullable(),
        autoClosedTrade: z.record(z.string(), z.unknown()).nullable(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () =>
      safeTool(async () => ({
        enabled: Boolean(shadowStatus),
        ...(shadowStatus
          ? await shadowStatus.getShadowStatus()
          : { status: null, autoClosedTrade: null }),
      })),
  );

  server.registerTool(
    "get_live_status",
    {
      title: "Inspect guarded Kraken live-bot status",
      description:
        "Return local arming, kill-switch, account reconciliation, tracked position, daily risk-stop, and blocker status. This tool cannot arm the bot or submit/cancel an order.",
      outputSchema: {
        status: z.record(z.string(), z.unknown()),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () =>
      safeTool(async () => ({
        status: liveStatus
          ? await liveStatus.getLiveStatus()
          : {
              mode: "live",
              configured: false,
              submissionEnabled: false,
              blockers: ["Live runtime is not configured"],
            },
      })),
  );

  return server;
}
