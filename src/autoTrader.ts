import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { NewsGateProvider, NewsGateSnapshot } from "./newsGate.js";
import type { ReferencePriceProvider } from "./referencePrice.js";
import type { TradingService } from "./tradingService.js";
import { isKrakenUnavailablePairError } from "./kraken.js";
import type { ScanResult, SupportedPair, TradingDecision } from "./types.js";
import type { ShadowBroker } from "./shadowBroker.js";

export type AutoTraderAction =
  | "POSITION_OPEN"
  | "POSITION_AUTO_CLOSED"
  | "PAPER_TARGET_REACHED"
  | "DAILY_BLOCKED"
  | "NEWS_GATE_BLOCKED"
  | "PAPER_TRADE_OPENED"
  | "SHADOW_POSITION_OPEN"
  | "SHADOW_POSITION_AUTO_CLOSED"
  | "SHADOW_TRADE_OPENED"
  | "SHADOW_NEWS_GATE_BLOCKED"
  | "SHADOW_NO_ENTRY"
  | "PAIR_SKIPPED"
  | "NO_ENTRY"
  | "ERROR";

export interface AutoTraderScanExplanation {
  pair: SupportedPair;
  decision: TradingDecision;
  triggerTimeframe?: "1M" | "5M" | "15M" | null;
  reasons: string[];
  reEvaluateWhen?: string;
  regime1h?: ScanResult["regime1h"];
  spreadPct?: number;
  dataAgeSeconds?: number;
}

export interface AutoTraderEvent {
  at: string;
  action: AutoTraderAction;
  pair?: SupportedPair;
  decision?: TradingDecision;
  closedTrades?: number;
  targetTrades?: number;
  remainingTrades?: number;
  shadowClosedTrades?: number;
  shadowRealizedPnlCad?: number;
  newsSourceUrls?: string[];
  blockedReason?: string;
  scanExplanations?: AutoTraderScanExplanation[];
  detail: string;
}

export interface AutoTraderJournal {
  record(event: AutoTraderEvent): Promise<void>;
}

export class JsonlAutoTraderJournal implements AutoTraderJournal {
  constructor(private readonly file: string) {}

  async record(event: AutoTraderEvent): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

export interface AutoPaperTraderOptions {
  service: TradingService;
  referencePrices: ReferencePriceProvider;
  newsGate: NewsGateProvider;
  journal: AutoTraderJournal;
  pairs: SupportedPair[];
  pollSeconds: number;
  tradeTarget: number;
  newsMaxAgeSeconds: number;
  shadowBroker?: ShadowBroker;
  shadowWhenDailyBlocked?: boolean;
  validatePair?: (pair: SupportedPair) => Promise<void>;
  clock?: () => number;
  logger?: (event: AutoTraderEvent) => void;
  onEvent?: (event: AutoTraderEvent) => Promise<void> | void;
}

export class AutoPaperTrader {
  private readonly clock: () => number;
  private readonly logger: (event: AutoTraderEvent) => void;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly validatedPairs = new Set<SupportedPair>();
  private readonly unavailablePairs = new Set<SupportedPair>();

  constructor(private readonly options: AutoPaperTraderOptions) {
    this.clock = options.clock || Date.now;
    this.logger = options.logger || ((event) => console.log(JSON.stringify(event)));
  }

  private event(
    action: AutoTraderAction,
    detail: string,
    extra: Pick<
      AutoTraderEvent,
      | "pair"
      | "decision"
      | "closedTrades"
      | "targetTrades"
      | "remainingTrades"
      | "shadowClosedTrades"
      | "shadowRealizedPnlCad"
      | "newsSourceUrls"
      | "blockedReason"
      | "scanExplanations"
    > = {},
  ): AutoTraderEvent {
    return {
      at: new Date(this.clock()).toISOString(),
      action,
      detail,
      ...extra,
    };
  }

  private scanExplanation(
    pair: SupportedPair,
    result: ScanResult,
  ): AutoTraderScanExplanation {
    return {
      pair,
      decision: result.decision,
      triggerTimeframe: result.triggerTimeframe,
      reasons: Array.isArray(result.reasons) ? result.reasons : [],
      reEvaluateWhen: result.reEvaluateWhen,
      regime1h: result.regime1h,
      spreadPct: result.spreadPct,
      dataAgeSeconds: result.dataAgeSeconds,
    };
  }

  private upsertScanExplanation(
    explanations: AutoTraderScanExplanation[],
    pair: SupportedPair,
    result: ScanResult,
  ): void {
    const next = this.scanExplanation(pair, result);
    const index = explanations.findIndex((item) => item.pair === pair);
    if (index >= 0) explanations[index] = next;
    else explanations.push(next);
  }

  private async publish(event: AutoTraderEvent): Promise<AutoTraderEvent> {
    this.logger(event);
    await this.options.journal.record(event);
    if (this.options.onEvent) await this.options.onEvent(event);
    return event;
  }

  private gateIsFresh(gate: NewsGateSnapshot): boolean {
    if (gate.status !== "clear" || !gate.checkedAt) return false;
    const checkedAt = Date.parse(gate.checkedAt);
    if (!Number.isFinite(checkedAt)) return false;
    const ageSeconds = Math.abs(this.clock() - checkedAt) / 1000;
    return ageSeconds <= this.options.newsMaxAgeSeconds;
  }

  async runOnce(): Promise<AutoTraderEvent> {
    const synchronized = await this.options.service.getPaperPortfolio();
    const closedTrades = synchronized.portfolio.state.closedTrades.length;
    const progress = {
      closedTrades,
      targetTrades: this.options.tradeTarget,
      remainingTrades: Math.max(0, this.options.tradeTarget - closedTrades),
    };
    if (closedTrades >= this.options.tradeTarget) {
      return this.publish(
        this.event(
          "PAPER_TARGET_REACHED",
          `Paper test completed with ${closedTrades} closed trades`,
          progress,
        ),
      );
    }
    if (synchronized.autoClosedTrade) {
      return this.publish(
        this.event(
          "POSITION_AUTO_CLOSED",
          `Paper position closed by ${synchronized.autoClosedTrade.reason}`,
          { pair: synchronized.autoClosedTrade.pair, ...progress },
        ),
      );
    }
    const portfolio = synchronized.portfolio;
    if (portfolio.state.position) {
      return this.publish(
        this.event("POSITION_OPEN", "Waiting for the existing stop or target", {
          pair: portfolio.state.position.pair,
          ...progress,
        }),
      );
    }
    const shadow = this.options.shadowBroker
      ? await this.options.shadowBroker.getShadowStatus()
      : null;
    if (shadow?.autoClosedTrade) {
      return this.publish(
        this.event(
          "SHADOW_POSITION_AUTO_CLOSED",
          `Shadow position closed by ${shadow.autoClosedTrade.reason}; main paper portfolio was unchanged`,
          {
            pair: shadow.autoClosedTrade.pair,
            shadowClosedTrades: shadow.status.closedTrades,
            shadowRealizedPnlCad: shadow.status.realizedPnlCad,
            ...progress,
          },
        ),
      );
    }
    if (portfolio.dailyTradingBlocked) {
      const shadowRequested =
        Boolean(this.options.shadowBroker) ||
        this.options.shadowWhenDailyBlocked === true;
      if (shadowRequested && this.options.shadowBroker && shadow) {
        return this.runShadowOnce(
          portfolio.dailyTradingBlockReason || "Daily trading is blocked",
          progress,
          shadow.status,
        );
      }
      if (shadowRequested) {
        return this.publish(
          this.event(
            "ERROR",
            "Shadow mode was requested but its isolated broker is unavailable; main daily protection remains active",
            progress,
          ),
        );
      }
      return this.publish(
        this.event(
          "DAILY_BLOCKED",
          portfolio.dailyTradingBlockReason || "Daily trading is blocked",
          progress,
        ),
      );
    }

    let lastDecision: TradingDecision | undefined;
    const scanExplanations: AutoTraderScanExplanation[] = [];
    for (const pair of this.options.pairs) {
      if (this.unavailablePairs.has(pair)) continue;
      try {
        if (this.options.validatePair && !this.validatedPairs.has(pair)) {
          await this.options.validatePair(pair);
          this.validatedPairs.add(pair);
        }

        const reference =
          await this.options.referencePrices.getReferencePrice(pair);
        const candidate = await this.options.service.scan({
          pair,
          referencePriceCad: reference.priceCad,
          referencePriceCapturedAt: reference.capturedAt,
        });
        lastDecision = candidate.result.decision;
        this.upsertScanExplanation(scanExplanations, pair, candidate.result);
        if (candidate.result.decision !== "NO_TRADE_NEWS_CHECK_REQUIRED") {
          continue;
        }

        const gate = await this.options.newsGate.getNewsStatus({
          pair,
          signalCapturedAt: candidate.result.capturedAt,
          setup15m: candidate.result.setup15m,
          trigger5m: candidate.result.trigger5m,
          triggerTimeframe: candidate.result.triggerTimeframe,
        });
        if (!this.gateIsFresh(gate)) {
          return this.publish(
            this.event(
              "NEWS_GATE_BLOCKED",
              gate.note || "A fresh clear news and macro-event check is required",
              {
                pair,
                decision: candidate.result.decision,
                newsSourceUrls: gate.sourceUrls,
                scanExplanations,
                ...progress,
              },
            ),
          );
        }

        const refreshedReference =
          await this.options.referencePrices.getReferencePrice(pair);
        const scan = await this.options.service.scan({
          pair,
          referencePriceCad: refreshedReference.priceCad,
          referencePriceCapturedAt: refreshedReference.capturedAt,
          newsStatus: gate.status,
          newsCheckedAt: gate.checkedAt,
        });
        lastDecision = scan.result.decision;
        this.upsertScanExplanation(scanExplanations, pair, scan.result);
        if (scan.signalId && scan.result.decision === "BUY_SETUP_CONFIRMED") {
          await this.options.service.placePaperTrade(scan.signalId);
          const sourceCount = gate.sourceUrls?.length || 0;
          return this.publish(
            this.event(
              "PAPER_TRADE_OPENED",
              sourceCount > 0
                ? `Confirmed setup opened in paper mode after a ${sourceCount}-source news check`
                : "Confirmed setup opened in paper mode after a fresh news check",
              {
                pair,
                decision: scan.result.decision,
                newsSourceUrls: gate.sourceUrls,
                scanExplanations,
                ...progress,
              },
            ),
          );
        }
      } catch (error) {
        if (!isKrakenUnavailablePairError(error)) throw error;
        this.unavailablePairs.add(pair);
        await this.publish(
          this.event(
            "PAIR_SKIPPED",
            `${pair} is not an available online Kraken spot market and was disabled until restart`,
            { pair, ...progress },
          ),
        );
      }
    }
    return this.publish(
      this.event("NO_ENTRY", "No pair has a confirmed executable setup", {
        decision: lastDecision,
        scanExplanations,
        ...progress,
      }),
    );
  }

  private async runShadowOnce(
    blockedReason: string,
    progress: Pick<
      AutoTraderEvent,
      "closedTrades" | "targetTrades" | "remainingTrades"
    >,
    shadow: Awaited<ReturnType<ShadowBroker["getShadowStatus"]>>["status"],
  ): Promise<AutoTraderEvent> {
    const shadowProgress = {
      shadowClosedTrades: shadow.closedTrades,
      shadowRealizedPnlCad: shadow.realizedPnlCad,
    };
    if (shadow.portfolio.state.position) {
      return this.publish(
        this.event(
          "SHADOW_POSITION_OPEN",
          "Main daily protection remains active; waiting for the shadow stop or target",
          {
            pair: shadow.portfolio.state.position.pair,
            ...progress,
            ...shadowProgress,
          },
        ),
      );
    }

    let lastDecision: TradingDecision | undefined;
    const scanExplanations: AutoTraderScanExplanation[] = [];
    for (const pair of this.options.pairs) {
      if (this.unavailablePairs.has(pair)) continue;
      try {
        if (this.options.validatePair && !this.validatedPairs.has(pair)) {
          await this.options.validatePair(pair);
          this.validatedPairs.add(pair);
        }
        const reference = await this.options.referencePrices.getReferencePrice(pair);
        const candidate = await this.options.service.scan({
          pair,
          balanceCad: Math.min(500, Math.max(10, shadow.portfolio.equityCad)),
          referencePriceCad: reference.priceCad,
          referencePriceCapturedAt: reference.capturedAt,
        });
        lastDecision = candidate.result.decision;
        this.upsertScanExplanation(scanExplanations, pair, candidate.result);
        if (candidate.result.decision !== "NO_TRADE_NEWS_CHECK_REQUIRED") {
          continue;
        }

        const gate = await this.options.newsGate.getNewsStatus({
          pair,
          signalCapturedAt: candidate.result.capturedAt,
          setup15m: candidate.result.setup15m,
          trigger5m: candidate.result.trigger5m,
          triggerTimeframe: candidate.result.triggerTimeframe,
        });
        if (!this.gateIsFresh(gate)) {
          return this.publish(
            this.event(
              "SHADOW_NEWS_GATE_BLOCKED",
              gate.note || "A fresh clear news and macro-event check is required",
              {
                pair,
                decision: candidate.result.decision,
                newsSourceUrls: gate.sourceUrls,
                blockedReason,
                scanExplanations,
                ...progress,
                ...shadowProgress,
              },
            ),
          );
        }

        const refreshedReference =
          await this.options.referencePrices.getReferencePrice(pair);
        const scan = await this.options.service.scan({
          pair,
          balanceCad: Math.min(500, Math.max(10, shadow.portfolio.equityCad)),
          referencePriceCad: refreshedReference.priceCad,
          referencePriceCapturedAt: refreshedReference.capturedAt,
          newsStatus: gate.status,
          newsCheckedAt: gate.checkedAt,
        });
        lastDecision = scan.result.decision;
        this.upsertScanExplanation(scanExplanations, pair, scan.result);
        if (scan.signalId && scan.result.decision === "BUY_SETUP_CONFIRMED") {
          const prepared = await this.options.service.prepareSimulatedTrade(
            scan.signalId,
            Math.min(500, Math.max(10, shadow.portfolio.equityCad)),
          );
          await this.options.shadowBroker!.openPosition(
            prepared.pair,
            prepared.plan,
            prepared.signal,
            blockedReason,
          );
          return this.publish(
            this.event(
              "SHADOW_TRADE_OPENED",
              "Confirmed setup recorded in the separate shadow portfolio; main paper cash and 100-trade progress were unchanged",
              {
                pair,
                decision: scan.result.decision,
                newsSourceUrls: gate.sourceUrls,
                blockedReason,
                scanExplanations,
                ...progress,
                ...shadowProgress,
              },
            ),
          );
        }
      } catch (error) {
        if (!isKrakenUnavailablePairError(error)) throw error;
        this.unavailablePairs.add(pair);
        await this.publish(
          this.event(
            "PAIR_SKIPPED",
            `${pair} is not an available online Kraken spot market and was disabled until restart`,
            { pair, ...progress, ...shadowProgress },
          ),
        );
      }
    }
    return this.publish(
      this.event(
        "SHADOW_NO_ENTRY",
        "Daily protection remains active and no confirmed shadow setup exists",
        {
          decision: lastDecision,
          blockedReason,
          scanExplanations,
          ...progress,
          ...shadowProgress,
        },
      ),
    );
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async loop(): Promise<void> {
    if (!this.running) return;
    try {
      const event = await this.runOnce();
      if (event.action === "PAPER_TARGET_REACHED") this.running = false;
    } catch (error) {
      await this.publish(
        this.event(
          "ERROR",
          error instanceof Error ? error.message : "Unknown auto-trader error",
        ),
      );
    } finally {
      if (this.running) {
        this.timer = setTimeout(
          () => void this.loop(),
          this.options.pollSeconds * 1000,
        );
      }
    }
  }
}
