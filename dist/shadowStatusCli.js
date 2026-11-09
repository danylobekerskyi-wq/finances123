import "dotenv/config";
import { loadConfig } from "./config.js";
import { ShadowBroker } from "./shadowBroker.js";
import { createDefaultKraken, createDefaultService } from "./server.js";
async function main() {
    const config = loadConfig();
    const kraken = createDefaultKraken(config);
    const service = createDefaultService(config, kraken);
    const broker = new ShadowBroker({
        dataFile: config.shadowStateFile,
        journalFile: config.shadowJournalFile,
        startingBalanceCad: config.paperStartingCad,
        dailyLossLimitPct: config.dailyLossLimitPct,
        feePctPerSide: config.takerFeePct,
        slippagePctPerSide: config.slippagePct,
        getTicker: (pair) => service.getMarketTicker(pair),
    });
    console.log(JSON.stringify({
        enabled: config.shadowLoggingEnabled,
        ...(await broker.getShadowStatus()),
    }, null, 2));
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
