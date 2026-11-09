import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LIVE_ARM_ACKNOWLEDGEMENT,
  armLiveTrading,
  getLiveArmStatus,
  stopLiveTrading,
} from "../src/liveControl.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("local live control", () => {
  it("requires an exact acknowledgement, expires, and honors LIVE_STOP", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "live-control-"));
    directories.push(directory);
    const armFile = path.join(directory, "armed.json");
    const killSwitchFile = path.join(directory, "LIVE_STOP");
    const now = Date.parse("2026-08-13T20:00:00Z");

    await expect(
      armLiveTrading({
        acknowledgement: "yes",
        armFile,
        killSwitchFile,
        clock: () => now,
      }),
    ).rejects.toThrow("exact acknowledgement");

    await armLiveTrading({
      acknowledgement: LIVE_ARM_ACKNOWLEDGEMENT,
      armFile,
      killSwitchFile,
      clock: () => now,
    });
    await expect(
      getLiveArmStatus({
        armFile,
        killSwitchFile,
        maxAgeMinutes: 60,
        clock: () => now + 30 * 60_000,
      }),
    ).resolves.toMatchObject({ armed: true, killSwitchActive: false });
    await expect(
      getLiveArmStatus({
        armFile,
        killSwitchFile,
        maxAgeMinutes: 60,
        clock: () => now + 61 * 60_000,
      }),
    ).resolves.toMatchObject({ armed: false });

    await stopLiveTrading({ armFile, killSwitchFile, clock: () => now });
    await expect(
      getLiveArmStatus({
        armFile,
        killSwitchFile,
        maxAgeMinutes: 60,
        clock: () => now,
      }),
    ).resolves.toMatchObject({ armed: false, killSwitchActive: true });
  });
});
