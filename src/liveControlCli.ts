import "dotenv/config";
import path from "node:path";
import {
  armLiveTrading,
  getLiveArmStatus,
  stopLiveTrading,
} from "./liveControl.js";

async function main(): Promise<void> {
  const dataDir = path.resolve(process.env.DATA_DIR || "./data");
  const armFile = path.resolve(
    process.env.LIVE_ARM_FILE || path.join(dataDir, "live-armed.json"),
  );
  const killSwitchFile = path.resolve(
    process.env.LIVE_KILL_SWITCH_FILE || path.join(dataDir, "LIVE_STOP"),
  );
  const maxAgeMinutes = Number(process.env.LIVE_ARM_MAX_AGE_MINUTES || 60);
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 1 || maxAgeMinutes > 1440) {
    throw new Error("LIVE_ARM_MAX_AGE_MINUTES must be between 1 and 1440");
  }
  const command = process.argv[2];
  if (command === "arm") {
    if (process.cwd().toLowerCase().includes("onedrive")) {
      throw new Error("Live trading cannot be armed inside a OneDrive folder");
    }
    await armLiveTrading({
      acknowledgement: process.argv[3] || "",
      armFile,
      killSwitchFile,
    });
    console.log(
      `Live entries armed for at most ${maxAgeMinutes} minutes.`,
    );
    return;
  }
  if (command === "stop") {
    await stopLiveTrading({
      armFile,
      killSwitchFile,
    });
    console.log(
      "LIVE_STOP activated. No new entries; an existing Kraken stop is not canceled.",
    );
    return;
  }
  if (command === "status") {
    console.log(
      JSON.stringify(
        await getLiveArmStatus({
          armFile,
          killSwitchFile,
          maxAgeMinutes,
        }),
        null,
        2,
      ),
    );
    return;
  }
  throw new Error("Use: liveControlCli.ts arm <acknowledgement> | stop | status");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
