import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const LIVE_ARM_ACKNOWLEDGEMENT =
  "I_UNDERSTAND_REAL_MONEY_CAN_BE_LOST";

interface LiveArmRecord {
  version: 1;
  armedAt: string;
}

export interface LiveArmStatus {
  armed: boolean;
  reason: string;
  armedAt: string | null;
  expiresAt: string | null;
  killSwitchActive: boolean;
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function unlinkIfPresent(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temp, file);
}

export async function getLiveArmStatus(input: {
  armFile: string;
  killSwitchFile: string;
  maxAgeMinutes: number;
  clock?: () => number;
}): Promise<LiveArmStatus> {
  const now = (input.clock || Date.now)();
  if (await fileExists(input.killSwitchFile)) {
    return {
      armed: false,
      reason: "Local LIVE_STOP kill switch is active",
      armedAt: null,
      expiresAt: null,
      killSwitchActive: true,
    };
  }
  let record: LiveArmRecord;
  try {
    record = JSON.parse(await readFile(input.armFile, "utf8")) as LiveArmRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        armed: false,
        reason: "Live trading has not been locally armed",
        armedAt: null,
        expiresAt: null,
        killSwitchActive: false,
      };
    }
    return {
      armed: false,
      reason: "Live arm file is unreadable or invalid",
      armedAt: null,
      expiresAt: null,
      killSwitchActive: false,
    };
  }
  const armedAtMs = Date.parse(record.armedAt);
  if (record.version !== 1 || !Number.isFinite(armedAtMs)) {
    return {
      armed: false,
      reason: "Live arm file has an invalid structure",
      armedAt: null,
      expiresAt: null,
      killSwitchActive: false,
    };
  }
  const expiresAtMs = armedAtMs + input.maxAgeMinutes * 60_000;
  const expiresAt = new Date(expiresAtMs).toISOString();
  if (now > expiresAtMs) {
    return {
      armed: false,
      reason: "Local live authorization expired; re-arm explicitly",
      armedAt: record.armedAt,
      expiresAt,
      killSwitchActive: false,
    };
  }
  return {
    armed: true,
    reason: "Locally armed for new live entries",
    armedAt: record.armedAt,
    expiresAt,
    killSwitchActive: false,
  };
}

export async function armLiveTrading(input: {
  acknowledgement: string;
  armFile: string;
  killSwitchFile: string;
  clock?: () => number;
}): Promise<void> {
  if (input.acknowledgement !== LIVE_ARM_ACKNOWLEDGEMENT) {
    throw new Error(
      `Arming requires the exact acknowledgement: ${LIVE_ARM_ACKNOWLEDGEMENT}`,
    );
  }
  await unlinkIfPresent(input.killSwitchFile);
  await atomicWrite(input.armFile, {
    version: 1,
    armedAt: new Date((input.clock || Date.now)()).toISOString(),
  } satisfies LiveArmRecord);
}

export async function stopLiveTrading(input: {
  armFile: string;
  killSwitchFile: string;
  clock?: () => number;
}): Promise<void> {
  await atomicWrite(input.killSwitchFile, {
    stoppedAt: new Date((input.clock || Date.now)()).toISOString(),
    effect:
      "No new entries. Existing exchange-side protective stop remains active.",
  });
  await unlinkIfPresent(input.armFile);
}
