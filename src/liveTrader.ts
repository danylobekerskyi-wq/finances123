import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import { getLiveArmStatus } from "./liveControl.js";
import { KrakenLiveBroker } from "./liveBroker.js";
import type { NewsGateProvider, NewsGateSnapshot } from "./newsGate.js";
import type { ReferencePriceProvider } from "./referencePrice.js";
import type { TradingService } from "./tradingService.js";
import type { LiveStatus, SupportedPair, TradingDecision } from "./types.js";

export type LiveTraderAction =
  | "LIVE_DISARMED"
  | "LIVE_ACCOUNT_BLOCKED"
  | "LIVE_DAILY_BLOCKED"
  | "LIVE_NEWS_BLOCKED"
  | "LIVE_POSITION_OPEN"
  | "LIVE_POSITION_OPENED"
  | "LIVE_POSITION_CLOSED"
  | "LIVE_ENTRY_NOT_FILLED"
  | "LIVE_NO_ENTRY"
  | "LIVE_ERROR";

export interface LiveTraderEvent {
  at: string;
  action: LiveTraderAction;
  pair?: SupportedPair;
  decision?: TradingDecision;
  detail: string;
}

export interface LiveTraderJournal {
  record(event: LiveTraderEvent): Promise<void>;
}

export interface LiveStatusProvider {
  getLiveStatus(): Promise<LiveStatus>;
}

export class JsonlLiveTraderJournal implements LiveTraderJournal {
  constructor(private readonly file: string) {}

  async record(event: LiveTraderEvent): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await appendFile(this.file, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

export class DisabledLiveStatusProvider implements LiveStatusProvider {
  constructor(private readonly config: AppConfig) {}

  async getLiveStatus(): Promise<LiveStatus> {
    const arm = await getLiveArmStatus({
      armFile: this.config.liveArmFile,
      killSwitchFile: this.config.liveKillSwitchFile,
      maxAgeMinutes: this.config.liveArmMaxAgeMinutes,
    });
    return {
      mode: "live",
      configured: false,
      submissionEnabled: false,
      autoTrading: false,
      armed: false,
      armReason: arm.reason,
      armExpiresAt: arm.expiresAt,
      killSwitchActive: arm.killSwitchActive,
      state: null,
      account: null,
      daily: null,
      blockers: [
        "Live trading is disabled; paper mode remains the default",
      ],
    };
  }
}

export interface AutoLiveTraderOptions {
  config: AppConfig;
  service: TradingService;
  broker: KrakenLiveBroker;
  referencePrices: ReferencePriceProvider;
  newsGate: NewsGateProvider;
  journal: LiveTraderJournal;
  pairs: SupportedPair[];
  pollSeconds: number;
  newsMaxAgeSeconds: number;
  clock?: () => number;
  logger?: (event: LiveTraderEvent) => void;
}

export class AutoLiveTrader implements LiveStatusProvider {
  private readonly clock: () => number;
  private readonly logger: (event: LiveTraderEvent) => void;
  private running = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: AutoLiveTraderOptions) {
    this.clock = options.clock || Date.now;
    this.logger = options.logger || ((event) => console.log(JSON.stringify(event)));
  }

  private event(
    action: LiveTraderAction,
    detail: string,
    extra: Pick<LiveTraderEvent, "pair" | "decision"> = {},
  ): LiveTraderEvent {
    return {
      at: new Date(this.clock()).toISOString(),
      action,
      detail,
      ...extra,
    };
  }

  private async publish(event: LiveTraderEvent): Promise<LiveTraderEvent> {
    this.logger(event);
    await this.options.journal.record(event);
    return event;
  }

  private gateIsFresh(gate: NewsGateSnapshot): boolean {
    if (gate.status !== "clear" || !gate.checkedAt) return false;
    const checkedAt = Date.parse(gate.checkedAt);
    if (!Number.isFinite(checkedAt)) return false;
    return (
      Math.abs(this.clock() - checkedAt) / 1000 <=
      this.options.newsMaxAgeSeconds
    );
  }

  private armStatus() {
    return getLiveArmStatus({
      armFile: this.options.config.liveArmFile,
      killSwitchFile: this.options.config.liveKillSwitchFile,
      maxAgeMinutes: this.options.config.liveArmMaxAgeMinutes,
      clock: this.clock,
    });
  }

  async getLiveStatus(): Promise<LiveStatus> {
    const arm = await this.armStatus();
    try {
      const snapshot = await this.options.broker.inspect();
      const blockers = [...snapshot.blockers];
      if (!arm.armed) blockers.push(arm.reason);
      return {
        mode: "live",
        configured: true,
        submissionEnabled: this.options.config.enableLiveOrderSubmission,
        autoTrading: this.options.config.autoLiveTradingEnabled,
        armed: arm.armed,
        armReason: arm.reason,
        armExpiresAt: arm.expiresAt,
        killSwitchActive: arm.killSwitchActive,
        state: snapshot.state,
        account: snapshot.account,
        daily: snapshot.daily,
        blockers: [...new Set(blockers)],
      };
    } catch (error) {
      return {
        mode: "live",
        configured: true,
        submissionEnabled: this.options.config.enableLiveOrderSubmission,
        autoTrading: this.options.config.autoLiveTradingEnabled,
        armed: arm.armed,
        armReason: arm.reason,
        armExpiresAt: arm.expiresAt,
        killSwitchActive: arm.killSwitchActive,
        state: null,
        account: null,
        daily: null,
        blockers: [
          error instanceof Error ? error.message : "Live status check failed",
        ],
      };
    }
  }

  async runOnce(): Promise<LiveTraderEvent> {
    const snapshot = await this.options.broker.reconcile();
    if (snapshot.closedTrade) {
      return this.publish(
        this.event(
          "LIVE_POSITION_CLOSED",
          `Kraken position closed by ${snapshot.closedTrade.reason}`,
          { pair: snapshot.closedTrade.pair },
        ),
      );
    }
    if (snapshot.state.position) {
      const closed = await this.options.broker.closeAtTarget();
      if (closed) {
        return this.publish(
          this.event("LIVE_POSITION_CLOSED", "Kraken target exit filled", {
            pair: closed.pair,
          }),
        );
      }
      return this.publish(
        this.event(
          "LIVE_POSITION_OPEN",
          "Existing position is protected by an exchange-side stop",
          { pair: snapshot.state.position.pair },
        ),
      );
    }

    const arm = await this.armStatus();
    if (!arm.armed) {
      return this.publish(this.event("LIVE_DISARMED", arm.reason));
    }
    if (snapshot.daily.blocked) {
      return this.publish(
        this.event(
          "LIVE_DAILY_BLOCKED",
          snapshot.daily.reason || "Daily live trading is blocked",
        ),
      );
    }
    if (snapshot.blockers.length > 0) {
      return this.publish(
        this.event("LIVE_ACCOUNT_BLOCKED", snapshot.blockers.join("; ")),
      );
    }

    const gate = await this.options.newsGate.getNewsStatus();
    if (!this.gateIsFresh(gate)) {
      return this.publish(
        this.event(
          "LIVE_NEWS_BLOCKED",
          gate.note || "A fresh clear news and macro check is required",
        ),
      );
    }

    let lastDecision: TradingDecision | undefined;
    for (const pair of this.options.pairs) {
      const reference = await this.options.referencePrices.getReferencePrice(pair);
      const scan = await this.options.service.scan({
        pair,
        balanceCad: snapshot.account.effectiveTradingEquityCad,
        referencePriceCad: reference.priceCad,
        referencePriceCapturedAt: reference.capturedAt,
        newsStatus: gate.status,
        newsCheckedAt: gate.checkedAt,
      });
      lastDecision = scan.result.decision;
      if (scan.signalId && scan.result.decision === "BUY_SETUP_CONFIRMED") {
        const prepared = await this.options.service.prepareLiveTrade(
          scan.signalId,
          snapshot.account.effectiveTradingEquityCad,
          this.options.config.liveEntrySlippagePct,
        );
        const opened = await this.options.broker.openLong(
          prepared.pair,
          prepared.plan,
        );
        if (!opened) {
          return this.publish(
            this.event(
              "LIVE_ENTRY_NOT_FILLED",
              "Kraken FOK entry did not fill; no position was opened",
              { pair },
            ),
          );
        }
        return this.publish(
          this.event(
            "LIVE_POSITION_OPENED",
            "Kraken FOK entry filled with an exchange-side protective stop",
            { pair },
          ),
        );
      }
    }
    return this.publish(
      this.event("LIVE_NO_ENTRY", "No pair has a confirmed executable setup", {
        decision: lastDecision,
      }),
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
      await this.runOnce();
    } catch (error) {
      await this.publish(
        this.event(
          "LIVE_ERROR",
          error instanceof Error ? error.message : "Unknown live trader error",
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
