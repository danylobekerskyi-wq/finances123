const NOTIFIABLE_ACTIONS = new Set([
    "PAPER_TRADE_OPENED",
    "POSITION_AUTO_CLOSED",
    "PAPER_TARGET_REACHED",
    "DAILY_BLOCKED",
    "NEWS_GATE_BLOCKED",
    "ERROR",
]);
function money(value) {
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(2)} USD`;
}
function price(value) {
    return value.toLocaleString("en-CA", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 8,
    });
}
function reasonLabel(reason) {
    if (reason === "TARGET")
        return "ціль";
    if (reason === "STOP")
        return "стоп";
    if (reason === "TIME_EXIT")
        return "вичерпано час утримання";
    return reason.toLowerCase();
}
function decisionLabel(decision) {
    const labels = {
        BUY_SETUP_CONFIRMED: "вхід підтверджено",
        WAIT_SETUP_NOT_CONFIRMED: "пробій закритою свічкою не підтверджено",
        NO_TRADE_DATA_NOT_RELIABLE: "ринкові дані недостатньо надійні",
        NO_TRADE_COSTS_TOO_HIGH: "комісії, стоп або ціль роблять вхід невигідним",
        NO_TRADE_NEWS_CHECK_REQUIRED: "потрібна актуальна перевірка новин",
        NO_TRADE_CROSSCHECK_REQUIRED: "потрібна перевірка ціни другим джерелом",
    };
    return labels[decision] || decision;
}
function translateReason(reason) {
    if (reason === "No latest closed 1M, 5M, or 15M candle closed above its resistance") {
        return "Жодна остання закрита свічка 1M, 5M або 15M не закрилася вище свого рівня опору";
    }
    if (reason === "A wick above resistance without a candle close is not a signal on any timeframe") {
        return "Прокол рівня лише тінню без закриття свічки не є сигналом";
    }
    if (reason === "A second current price source was not supplied") {
        return "Немає актуальної перевірки ціни з другого джерела";
    }
    if (reason === "Not enough closed candles for multi-timeframe analysis") {
        return "Недостатньо закритих свічок для аналізу кількох таймфреймів";
    }
    if (reason === "Technical invalidation is not below the executable ask") {
        return "Рівень технічного стопа не розташований нижче доступної ціни входу";
    }
    if (reason === "A material news or macro event blocks new entries") {
        return "Важлива новина або макроподія блокує нові входи";
    }
    if (reason === "A current news and macro-event check is required") {
        return "Потрібна актуальна перевірка новин і макроподій";
    }
    if (reason === "A 1M, 5M, or 15M breakout candle closed above resistance") {
        return "Свічка пробою 1M, 5M або 15M закрилася вище опору";
    }
    if (reason === "The breakout close is confirmed") {
        return "Закриття свічки після пробою підтверджено";
    }
    const closedBreakout = reason.match(/^Latest closed (1M|5M|15M) candle finished above its resistance (.+)$/);
    if (closedBreakout) {
        return `Закрита свічка ${closedBreakout[1]} завершилася вище опору ${closedBreakout[2]}`;
    }
    const noRetest = reason.match(/^(1M|5M|15M) breakout close is sufficient; no retest is required$/);
    if (noRetest) {
        return `Закриття свічки ${noRetest[1]} вище рівня достатньо; ретест не обов’язковий`;
    }
    const staleCandle = reason.match(/^Latest closed 1M candle is (.+) seconds old$/);
    if (staleCandle)
        return `Остання закрита свічка 1M застаріла на ${staleCandle[1]} с`;
    const spread = reason.match(/^Spread (.+)% exceeds (.+)%$/);
    if (spread)
        return `Спред ${spread[1]}% перевищує ліміт ${spread[2]}%`;
    const reference = reason.match(/^Reference source differs by (.+)% or is stale$/);
    if (reference)
        return `Друге джерело ціни відрізняється на ${reference[1]}% або застаріло`;
    const target = reason.match(/^Fees, slippage, and stop require a (.+)% target$/);
    if (target)
        return `Комісії, прослизання і стоп вимагають занадто далекої цілі ${target[1]}%`;
    if (reason === "Available room or position size is insufficient for 2R net of costs") {
        return "Розміру позиції або потенціалу руху недостатньо для чистого співвідношення 2R";
    }
    return reason;
}
function translateReEvaluation(value) {
    if (value === "Wait for a 1M, 5M, or 15M candle to close above the highest high of its previous 20 closed candles") {
        return "дочекатися закриття свічки 1M, 5M або 15M вище максимуму попередніх 20 закритих свічок";
    }
    if (value === "Wait for a fresh, complete Kraken snapshot with an acceptable spread") {
        return "дочекатися повних свіжих даних Kraken і прийнятного спреду";
    }
    if (value === "Cross-check Kraken against a second source captured within 10 minutes") {
        return "звірити ціну Kraken з другим джерелом не старшим за 10 хвилин";
    }
    if (value === "Refresh both exchange and reference prices before evaluating an entry") {
        return "оновити біржову ціну та друге джерело перед новою оцінкою входу";
    }
    if (value === "Re-scan after confirming no material event risk within the next 15 minutes") {
        return "повторити скан після підтвердження відсутності важливого ризику новин у найближчі 15 хвилин";
    }
    return value;
}
function whyLines(event) {
    const lines = ["Чому бот прийняв це рішення:"];
    if (event.blockedReason) {
        lines.push(`• Денний PAPER-захист: ${event.blockedReason}`);
    }
    const explanations = event.scanExplanations || [];
    if (explanations.length > 0) {
        lines.push(`• Проскановано пар: ${explanations.length}`);
        const byDecision = new Map();
        for (const scan of explanations) {
            const pairs = byDecision.get(scan.decision) || [];
            pairs.push(scan.pair);
            byDecision.set(scan.decision, pairs);
        }
        for (const [decision, pairs] of byDecision) {
            lines.push(`• ${decisionLabel(decision)}: ${pairs.join(", ")}`);
        }
        const groupedReasons = new Map();
        for (const scan of explanations) {
            for (const rawReason of scan.reasons.slice(0, 2)) {
                const reason = translateReason(rawReason);
                const pairs = groupedReasons.get(reason) || [];
                if (!pairs.includes(scan.pair))
                    pairs.push(scan.pair);
                groupedReasons.set(reason, pairs);
            }
        }
        let shown = 0;
        for (const [reason, pairs] of groupedReasons) {
            if (shown >= 4)
                break;
            lines.push(`• ${pairs.join(", ")}: ${reason}`);
            shown += 1;
        }
        const nextCondition = explanations
            .map((scan) => scan.reEvaluateWhen)
            .find((value) => Boolean(value));
        if (nextCondition) {
            lines.push(`Що потрібно далі: ${translateReEvaluation(nextCondition)}`);
        }
    }
    else if (event.action === "POSITION_OPEN") {
        lines.push("• Уже є відкрита PAPER-позиція, тому другу позицію бот не відкриває");
        lines.push("Що потрібно далі: дочекатися симульованого стопа або цілі");
    }
    else if (event.action === "SHADOW_POSITION_OPEN") {
        lines.push("• Уже є відкрита SHADOW-позиція, тому другу позицію бот не відкриває");
        lines.push("Що потрібно далі: дочекатися симульованого стопа або цілі");
    }
    else if (event.action === "DAILY_BLOCKED") {
        lines.push(`• ${event.detail}`);
    }
    else if (event.decision) {
        lines.push(`• ${decisionLabel(event.decision)}`);
    }
    else {
        lines.push(`• ${event.detail}`);
    }
    return lines;
}
export class TelegramTradingReporter {
    options;
    fetchImpl;
    clock;
    logger;
    lastSentAt = new Map();
    constructor(options) {
        this.options = options;
        this.fetchImpl = options.fetchImpl || fetch;
        this.clock = options.clock || Date.now;
        this.logger = options.logger || ((message, error) => console.error(message, error));
    }
    async sendStartup() {
        return this.send([
            "🟢 CryptoBot запущено",
            "Режим: PAPER",
            "Telegram-звіти: УВІМКНЕНО",
            "Реальні ордери: ВИМКНЕНО",
        ].join("\n"));
    }
    async sendTest() {
        return this.send([
            "✅ Telegram підключено до CryptoBot",
            "Режим: PAPER",
            "Реальні ордери: ВИМКНЕНО",
        ].join("\n"));
    }
    async notify(event) {
        if (this.options.notificationMode !== "all" &&
            !NOTIFIABLE_ACTIONS.has(event.action)) {
            return false;
        }
        if (this.isDuplicate(event))
            return false;
        let text;
        try {
            const report = await this.options.service.getPaperReportSnapshot();
            text = this.formatEvent(event, report);
        }
        catch (error) {
            this.logger("Telegram report snapshot failed", error);
            text = this.formatWithoutSnapshot(event);
        }
        const sent = await this.send(text);
        if (sent)
            this.lastSentAt.set(this.dedupeKey(event), this.clock());
        return sent;
    }
    formatWithoutSnapshot(event) {
        return [
            `⚠️ Подія CryptoBot: ${event.action}`,
            ...(event.pair ? [`Пара: ${event.pair}`] : []),
            ...(event.decision ? [`Рішення: ${event.decision}`] : []),
            event.detail,
            ...whyLines(event),
            ...(event.closedTrades !== undefined
                ? [`Прогрес: ${event.closedTrades}/${event.targetTrades || "—"}`]
                : []),
            "Paper-знімок тимчасово недоступний",
            "Реальні ордери: ВИМКНЕНО",
            `Час: ${event.at}`,
        ].join("\n");
    }
    formatEvent(event, report) {
        const { progress, portfolio } = report;
        const footer = [
            `Прогрес: ${progress.closedTrades}/${progress.targetTrades}`,
            `Paper equity: ${portfolio.equityCad.toFixed(2)} USD`,
            `Загальний PnL: ${money(progress.realizedPnlCad)}`,
            "Реальні ордери: ВИМКНЕНО",
        ];
        if (event.action === "PAPER_TRADE_OPENED") {
            const position = portfolio.state.position;
            return [
                "🟡 PAPER-угоду відкрито",
                `Пара: ${event.pair || position?.pair || "—"}`,
                ...(position
                    ? [
                        `Вхід: ${price(position.entryPriceCad)}`,
                        `Стоп: ${price(position.stopCad)}`,
                        `Ціль: ${price(position.targetCad)}`,
                        ...(position.maxHoldingMinutes ? [`Ліміт часу: ${position.maxHoldingMinutes} хв; вихід до ${position.exitDeadline}`] : []),
                        `Плановий ризик: ${position.plannedRiskCad.toFixed(2)} USD`,
                    ]
                    : []),
                ...whyLines(event),
                ...footer,
            ].join("\n");
        }
        if (event.action === "POSITION_AUTO_CLOSED") {
            const trades = portfolio.state.closedTrades;
            const trade = trades[trades.length - 1];
            const won = (trade?.realizedPnlCad || 0) > 0;
            return [
                won ? "✅ PAPER-угоду закрито" : "🔴 PAPER-угоду закрито",
                `Пара: ${event.pair || trade?.pair || "—"}`,
                ...(trade
                    ? [
                        `Причина: ${reasonLabel(trade.reason)}`,
                        `Результат: ${money(trade.realizedPnlCad)}`,
                        `Результат R: ${trade.resultR.toFixed(2)}`,
                    ]
                    : [`Причина: ${event.detail}`]),
                `Статистика: ${progress.wins}W / ${progress.losses}L`,
                ...whyLines(event),
                ...footer,
            ].join("\n");
        }
        if (event.action === "PAPER_TARGET_REACHED") {
            return [
                "🏁 PAPER-тест завершено",
                `Угод: ${progress.closedTrades}/${progress.targetTrades}`,
                `Статистика: ${progress.wins}W / ${progress.losses}L / ${progress.breakeven}BE`,
                `Win rate: ${progress.winRatePct.toFixed(1)}%`,
                `Average R: ${progress.averageResultR.toFixed(2)}`,
                `Profit factor: ${progress.profitFactor?.toFixed(2) || "—"}`,
                ...footer.slice(1),
            ].join("\n");
        }
        if (event.action === "DAILY_BLOCKED") {
            return ["⛔ Денний paper-захист активний", event.detail, ...whyLines(event), ...footer].join("\n");
        }
        if (event.action === "NEWS_GATE_BLOCKED") {
            return [
                "⚠️ Вхід заблоковано перевіркою новин",
                ...(event.pair ? [`Пара: ${event.pair}`] : []),
                event.detail,
                ...whyLines(event),
                ...footer,
            ].join("\n");
        }
        if (event.action !== "ERROR") {
            return [
                `ℹ️ Подія CryptoBot: ${event.action}`,
                ...(event.pair ? [`Пара: ${event.pair}`] : []),
                ...(event.decision ? [`Рішення: ${event.decision}`] : []),
                event.detail,
                ...whyLines(event),
                ...(event.shadowClosedTrades !== undefined
                    ? [`Shadow-угод закрито: ${event.shadowClosedTrades}`]
                    : []),
                ...(event.shadowRealizedPnlCad !== undefined
                    ? [`Shadow PnL: ${money(event.shadowRealizedPnlCad)}`]
                    : []),
                ...footer,
                `Час: ${event.at}`,
            ].join("\n");
        }
        return ["🚨 Помилка CryptoBot", event.detail, ...footer].join("\n");
    }
    dedupeKey(event) {
        return `${event.action}|${event.pair || ""}|${event.detail}`;
    }
    isDuplicate(event) {
        if (this.options.notificationMode === "all")
            return false;
        if (event.action === "PAPER_TRADE_OPENED" ||
            event.action === "POSITION_AUTO_CLOSED" ||
            event.action === "PAPER_TARGET_REACHED") {
            return false;
        }
        const previous = this.lastSentAt.get(this.dedupeKey(event));
        return previous !== undefined && this.clock() - previous < 6 * 60 * 60 * 1000;
    }
    async send(text) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        try {
            const response = await this.fetchImpl(`https://api.telegram.org/bot${this.options.botToken}/sendMessage`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    chat_id: this.options.chatId,
                    text: text.slice(0, 4_096),
                    disable_web_page_preview: true,
                }),
                signal: controller.signal,
            });
            if (!response.ok) {
                throw new Error(`Telegram API returned HTTP ${response.status}`);
            }
            return true;
        }
        catch (error) {
            this.logger("Telegram send failed", error);
            return false;
        }
        finally {
            clearTimeout(timer);
        }
    }
}
