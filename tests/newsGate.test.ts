import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileNewsGate, PaperAutoClearNewsGate, writeNewsGate } from "../src/newsGate.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("FileNewsGate", () => {
  it("fails closed when no gate file exists", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "news-gate-"));
    temporaryDirectories.push(directory);
    const gate = new FileNewsGate(path.join(directory, "missing.json"));
    await expect(gate.getNewsStatus()).resolves.toEqual({ status: "unknown" });
  });


  it("auto-refreshes a clear gate for paper-only testing", async () => {
    const gate = new PaperAutoClearNewsGate();
    const first = await gate.getNewsStatus();
    expect(first.status).toBe("clear");
    expect(Number.isFinite(Date.parse(first.checkedAt || ""))).toBe(true);
    expect(first.note).toContain("Paper-only automatic gate refresh");
  });

  it("persists a timestamped manual news decision", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "news-gate-"));
    temporaryDirectories.push(directory);
    const file = path.join(directory, "gate.json");
    await writeNewsGate(
      file,
      "clear",
      "No scheduled event or material headline",
      () => Date.parse("2026-08-13T20:00:00Z"),
    );
    await expect(new FileNewsGate(file).getNewsStatus()).resolves.toEqual({
      status: "clear",
      checkedAt: "2026-08-13T20:00:00.000Z",
      note: "No scheduled event or material headline",
    });
  });
});
