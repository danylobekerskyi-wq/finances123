import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getLiveArmStatus } from "./liveControl.js";
export class JsonlLiveTraderJournal {
    file;
    constructor(file) {
        this.file = file;
    }
    async record(event) {
        await mkdir(path.dirname(this.file), { recursive: true });
        await appendFile(this.file, `${JSON.stringify(event)}\n`, {
            encoding: "utf8",
            mode: 0o600,
        });
    }
}
export class DisabledLiveStatusProvider {
    config;
    constructor(config) {
        this.config = config;
    }
    async getLiveStatus() {
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
export class AutoLiveTrader {
    options;
    clock;
    logger;
    running = false;
    timer = null;
    constructor(options) {
        this.options = options;
        this.clock = options.clock || Date.now;
        this.logger = options.logger || ((event) => console.log(JSON.stringify(event)));
    }
    event(action, detail, extra = {}) {
        return {
            at: new Date(this.clock()).toISOString(),
            action,
            detail,
            ...extra,
        };
    }
    async publish(event) {
        this.logger(event);
        await this.options.journal.record(event);
        return event;
    }
    gateIsFresh(gate) {
        if (gate.status !== "clear" || !gate.checkedAt)
            return false;
        const checkedAt = Date.parse(gate.checkedAt);
        if (!Number.isFinite(checkedAt))
            return false;
        return (Math.abs(this.clock() - checkedAt) / 1000 <=
            this.options.newsMaxAgeSeconds);
    }
    armStatus() {
        return getLiveArmStatus({
            armFile: this.options.config.liveArmFile,
            killSwitchFile: this.options.config.liveKillSwitchFile,
            maxAgeMinutes: this.options.config.liveArmMaxAgeMinutes,
            clock: this.clock,
        });
    }
    async getLiveStatus() {
        const arm = await this.armStatus();
        try {
            const snapshot = await this.options.broker.inspect();
            const blockers = [...snapshot.blockers];
            if (!arm.armed)
                blockers.push(arm.reason);
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
        }
        catch (error) {
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
    async runOnce() {
        const snapshot = await this.options.broker.reconcile();
        if (snapshot.closedTrade) {
            return this.publish(this.event("LIVE_POSITION_CLOSED", `Kraken position closed by ${snapshot.closedTrade.reason}`, { pair: snapshot.closedTrade.pair }));
        }
        if (snapshot.state.position) {
            const closed = await this.options.broker.closeAtTarget();
            if (closed) {
                return this.publish(this.event("LIVE_POSITION_CLOSED", "Kraken target exit filled", {
                    pair: closed.pair,
                }));
            }
            return this.publish(this.event("LIVE_POSITION_OPEN", "Existing position is protected by an exchange-side stop", { pair: snapshot.state.position.pair }));
        }
        const arm = await this.armStatus();
        if (!arm.armed) {
            return this.publish(this.event("LIVE_DISARMED", arm.reason));
        }
        if (snapshot.daily.blocked) {
            return this.publish(this.event("LIVE_DAILY_BLOCKED", snapshot.daily.reason || "Daily live trading is blocked"));
        }
        if (snapshot.blockers.length > 0) {
            return this.publish(this.event("LIVE_ACCOUNT_BLOCKED", snapshot.blockers.join("; ")));
        }
        const gate = await this.options.newsGate.getNewsStatus();
        if (!this.gateIsFresh(gate)) {
            return this.publish(this.event("LIVE_NEWS_BLOCKED", gate.note || "A fresh clear news and macro check is required"));
        }
        let lastDecision;
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
                const prepared = await this.options.service.prepareLiveTrade(scan.signalId, snapshot.account.effectiveTradingEquityCad, this.options.config.liveEntrySlippagePct);
                const opened = await this.options.broker.openLong(prepared.pair, prepared.plan);
                if (!opened) {
                    return this.publish(this.event("LIVE_ENTRY_NOT_FILLED", "Kraken FOK entry did not fill; no position was opened", { pair }));
                }
                return this.publish(this.event("LIVE_POSITION_OPENED", "Kraken FOK entry filled with an exchange-side protective stop", { pair }));
            }
        }
        return this.publish(this.event("LIVE_NO_ENTRY", "No pair has a confirmed executable setup", {
            decision: lastDecision,
        }));
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        void this.loop();
    }
    stop() {
        this.running = false;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = null;
    }
    async loop() {
        if (!this.running)
            return;
        try {
            await this.runOnce();
        }
        catch (error) {
            await this.publish(this.event("LIVE_ERROR", error instanceof Error ? error.message : "Unknown live trader error"));
        }
        finally {
            if (this.running) {
                this.timer = setTimeout(() => void this.loop(), this.options.pollSeconds * 1000);
            }
        }
    }
}
