import "dotenv/config";
import { loadConfig } from "./config.js";
import { writeNewsGate } from "./newsGate.js";

const status = process.argv[2];
if (status !== "clear" && status !== "blocked") {
  console.error('Usage: npm run news:clear -- "note" or npm run news:block -- "note"');
  process.exitCode = 1;
} else {
  const note = process.argv.slice(3).join(" ").trim();
  if (note.length < 3) {
    console.error("A short note describing the news check is required");
    process.exitCode = 1;
  } else {
    const config = loadConfig();
    const snapshot = await writeNewsGate(
      config.autoNewsGateFile,
      status,
      note,
    );
    console.log(JSON.stringify(snapshot));
  }
}
