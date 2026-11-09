import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
export class PaperAutoClearNewsGate {
    async getNewsStatus() {
        return {
            status: "clear",
            checkedAt: new Date().toISOString(),
            note: "Paper-only automatic gate refresh (no external news verification)",
        };
    }
}
export class FileNewsGate {
    file;
    constructor(file) {
        this.file = file;
    }
    async getNewsStatus() {
        let raw;
        try {
            raw = await readFile(this.file, "utf8");
        }
        catch (error) {
            if (error.code === "ENOENT") {
                return { status: "unknown" };
            }
            throw error;
        }
        let value;
        try {
            value = JSON.parse(raw);
        }
        catch {
            return { status: "unknown", note: "News gate file is not valid JSON" };
        }
        if (!value || typeof value !== "object")
            return { status: "unknown" };
        const candidate = value;
        if (candidate.status !== "clear" &&
            candidate.status !== "blocked" &&
            candidate.status !== "unknown") {
            return { status: "unknown", note: "News gate status is invalid" };
        }
        if (candidate.checkedAt !== undefined &&
            !Number.isFinite(Date.parse(candidate.checkedAt))) {
            return { status: "unknown", note: "News gate timestamp is invalid" };
        }
        return {
            status: candidate.status,
            checkedAt: candidate.checkedAt,
            note: candidate.note,
            sourceUrls: Array.isArray(candidate.sourceUrls)
                ? candidate.sourceUrls.filter((value) => typeof value === "string")
                : undefined,
        };
    }
}
export async function writeNewsGate(file, status, note, clock = Date.now) {
    const snapshot = {
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
