import "dotenv/config";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { AutoPaperTrader, JsonlAutoTraderJournal } from "./autoTrader.js";
import { loadConfig } from "./config.js";
import { KrakenClient } from "./kraken.js";
import { KrakenLiveBroker } from "./liveBroker.js";
import { AutoLiveTrader, DisabledLiveStatusProvider, JsonlLiveTraderJournal, } from "./liveTrader.js";
import { createTradingMcpServer } from "./mcp.js";
import { FileNewsGate, PaperAutoClearNewsGate } from "./newsGate.js";
import { OpenAIWebSearchNewsGate } from "./openaiNewsGate.js";
import { PaperBroker } from "./paperBroker.js";
import { ShadowBroker } from "./shadowBroker.js";
import { CoinbaseReferenceClient } from "./referencePrice.js";
import { TradingService } from "./tradingService.js";
import { TelegramTradingReporter } from "./telegramReporter.js";
export function createDefaultKraken(config) {
    return new KrakenClient({
        baseUrl: config.krakenBaseUrl,
        apiKey: config.krakenApiKey,
        apiSecret: config.krakenApiSecret,
        enableOrderValidation: config.enableKrakenOrderValidation,
        enableLiveOrderSubmission: config.enableLiveOrderSubmission,
    });
}
export function createDefaultService(config, kraken = createDefaultKraken(config), referencePrices) {
    const broker = new PaperBroker({
        dataFile: path.join(config.dataDir, "paper-state.json"),
        startingBalanceCad: config.paperStartingCad,
        dailyLossLimitPct: config.dailyLossLimitPct,
        feePctPerSide: config.takerFeePct,
        slippagePctPerSide: config.slippagePct,
    });
    return new TradingService(config, kraken, broker, referencePrices);
}
export function createApp(config, service, liveStatus, shadowStatus) {
    const app = createMcpExpressApp({ host: config.host });
    app.get("/health", (_req, res) => {
        res.json({
            status: "ok",
            service: "crypto-trading-mcp",
            mode: config.tradingMode,
            liveOrderSubmission: config.enableLiveOrderSubmission,
            autoPaperTrading: config.autoPaperTradingEnabled,
            shadowLogging: config.shadowLoggingEnabled,
            shadowRuntimeReady: Boolean(shadowStatus && config.shadowWhenDailyBlocked),
            autoLiveTrading: config.autoLiveTradingEnabled,
            autoPaperNewsProvider: config.autoNewsProvider,
            telegramNotifications: config.telegramNotificationsEnabled,
        });
    });
    app.post("/mcp", async (req, res) => {
        const server = createTradingMcpServer(service, liveStatus, shadowStatus);
        try {
            const transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: undefined,
            });
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            res.on("close", () => {
                void transport.close();
                void server.close();
            });
        }
        catch (error) {
            console.error("MCP request failed", error);
            if (!res.headersSent) {
                res.status(500).json({
                    jsonrpc: "2.0",
                    error: { code: -32603, message: "Internal server error" },
                    id: null,
                });
            }
        }
    });
    const methodNotAllowed = (_req, res) => {
        res.status(405).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Method not allowed" },
            id: null,
        });
    };
    app.get("/mcp", methodNotAllowed);
    app.delete("/mcp", methodNotAllowed);
    return app;
}
export function startServer(config = loadConfig()) {
    const kraken = createDefaultKraken(config);
    const referencePrices = new CoinbaseReferenceClient({
        baseUrl: config.coinbaseBaseUrl,
    });
    const service = createDefaultService(config, kraken, referencePrices);
    const shadowBroker = config.shadowLoggingEnabled
        ? new ShadowBroker({
            dataFile: config.shadowStateFile,
            journalFile: config.shadowJournalFile,
            startingBalanceCad: config.paperStartingCad,
            dailyLossLimitPct: config.dailyLossLimitPct,
            feePctPerSide: config.takerFeePct,
            slippagePctPerSide: config.slippagePct,
            getTicker: (pair) => service.getMarketTicker(pair),
        })
        : null;
    const manualNewsGate = new FileNewsGate(config.autoNewsGateFile);
    const paperNewsGate = config.autoNewsProvider === "openai" && config.openAiApiKey
        ? new OpenAIWebSearchNewsGate({
            apiKey: config.openAiApiKey,
            model: config.openAiNewsModel,
        })
        : config.autoNewsProvider === "paper-auto"
            ? new PaperAutoClearNewsGate()
            : manualNewsGate;
    const telegramReporter = config.telegramNotificationsEnabled &&
        config.telegramBotToken &&
        config.telegramChatId
        ? new TelegramTradingReporter({
            botToken: config.telegramBotToken,
            chatId: config.telegramChatId,
            service,
            notificationMode: config.telegramNotificationMode,
        })
        : null;
    const autoPaperTrader = config.autoPaperTradingEnabled
        ? new AutoPaperTrader({
            service,
            referencePrices,
            newsGate: paperNewsGate,
            journal: new JsonlAutoTraderJournal(path.join(config.dataDir, "auto-trader.jsonl")),
            pairs: config.autoTraderPairs,
            pollSeconds: config.autoTraderPollSeconds,
            tradeTarget: config.paperTradeTarget,
            newsMaxAgeSeconds: config.autoNewsMaxAgeSeconds,
            shadowBroker: shadowBroker || undefined,
            shadowWhenDailyBlocked: config.shadowWhenDailyBlocked,
            validatePair: (pair) => kraken.assertPairAvailable(pair),
            onEvent: telegramReporter
                ? (event) => telegramReporter.notify(event).then(() => undefined)
                : undefined,
        })
        : null;
    const liveBroker = config.enableLiveOrderSubmission
        ? new KrakenLiveBroker({
            client: kraken,
            stateFile: config.liveStateFile,
            capitalCapCad: config.liveCapitalCapCad,
            maxOrderCad: config.liveMaxOrderCad,
            dailyLossLimitPct: config.dailyLossLimitPct,
            entrySlippagePct: config.liveEntrySlippagePct,
            exitSlippagePct: config.liveExitSlippagePct,
        })
        : null;
    const autoLiveTrader = liveBroker
        ? new AutoLiveTrader({
            config,
            service,
            broker: liveBroker,
            referencePrices,
            newsGate: manualNewsGate,
            journal: new JsonlLiveTraderJournal(config.liveJournalFile),
            pairs: config.autoTraderPairs,
            pollSeconds: config.autoTraderPollSeconds,
            newsMaxAgeSeconds: config.autoNewsMaxAgeSeconds,
        })
        : null;
    const liveStatus = autoLiveTrader || new DisabledLiveStatusProvider(config);
    const app = createApp(config, service, liveStatus, shadowBroker || undefined);
    const listener = app.listen(config.port, config.host, () => {
        console.log(`crypto-trading-mcp listening at http://${config.host}:${config.port}/mcp (mode=${config.tradingMode}; live-capability=${config.enableLiveOrderSubmission}; auto-paper=${config.autoPaperTradingEnabled}; shadow=${config.shadowLoggingEnabled}; shadow-runtime=${Boolean(shadowBroker && config.shadowWhenDailyBlocked)}; paper-news=${config.autoNewsProvider}; telegram=${config.telegramNotificationsEnabled ? config.telegramNotificationMode : "false"}; auto-live=${config.autoLiveTradingEnabled})`);
        autoPaperTrader?.start();
        if (telegramReporter && config.telegramNotifyStartup) {
            void telegramReporter.sendStartup();
        }
        if (config.autoLiveTradingEnabled)
            autoLiveTrader?.start();
    });
    const shutdown = () => {
        autoPaperTrader?.stop();
        autoLiveTrader?.stop();
        listener.close(() => process.exit(0));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
}
const isMain = process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain)
    startServer();
