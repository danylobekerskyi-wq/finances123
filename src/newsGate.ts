import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SetupName, SupportedPair } from "./types.js";

export interface NewsGateContext {
  pair: SupportedPair;
  signalCapturedAt: string;
  setup15m: SetupName;
  trigger5m: boolean;
  triggerTimeframe?: "1M" | "5M" | "15M" | null;
}

export interface NewsGateSnapshot {
  status: "clear" | "unknown" | "blocked";
  checkedAt?: string;
  note?: string;
  sourceUrls?: string[];
}

export interface NewsGateProvider {
  getNewsStatus(context?: NewsGateContext): Promise<NewsGateSnapshot>;
}


export class PaperAutoClearNewsGate implements NewsGateProvider {
  async getNewsStatus(): Promise<NewsGateSnapshot> {
    return {
      status: "clear",
      checkedAt: new Date().toISOString(),
      note: "Paper-only automatic gate refresh (no external news verification)",
    };
  }
}

export class FileNewsGate implements NewsGateProvider {
  constructor(private readonly file: string) {}

  async getNewsStatus(): Promise<NewsGateSnapshot> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { status: "unknown" };
      }
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return { status: "unknown", note: "News gate file is not valid JSON" };
    }
    if (!value || typeof value !== "object") return { status: "unknown" };
    const candidate = value as Partial<NewsGateSnapshot>;
    if (
      candidate.status !== "clear" &&
      candidate.status !== "blocked" &&
      candidate.status !== "unknown"
    ) {
      return { status: "unknown", note: "News gate status is invalid" };
    }
    if (
      candidate.checkedAt !== undefined &&
      !Number.isFinite(Date.parse(candidate.checkedAt))
    ) {
      return { status: "unknown", note: "News gate timestamp is invalid" };
    }
    return {
      status: candidate.status,
      checkedAt: candidate.checkedAt,
      note: candidate.note,
      sourceUrls: Array.isArray(candidate.sourceUrls)
        ? candidate.sourceUrls.filter(
            (value): value is string => typeof value === "string",
          )
        : undefined,
    };
  }
}

export async function writeNewsGate(
  file: string,
  status: "clear" | "blocked",
  note: string,
  clock: () => number = Date.now,
): Promise<NewsGateSnapshot> {
  const snapshot: NewsGateSnapshot = {
    status,
    checkedAt: new Date(clock()).toISOString(),
    note,
  };
  await mkdir(path.dirname(file), { recursive: true });
  const tempFile = `${file}.${process.pid}.tmp`;
  await writeFile(tempFile, `${JSON.stringify(snapshot, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempFile, file);
  return snapshot;
}
