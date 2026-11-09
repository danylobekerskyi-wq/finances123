import "dotenv/config";
import { loadConfig } from "./config.js";
import { createDefaultKraken, createDefaultService } from "./server.js";
import { TelegramTradingReporter } from "./telegramReporter.js";

const config = loadConfig();

if (
  !config.telegramNotificationsEnabled ||
  !config.telegramBotToken ||
  !config.telegramChatId
) {
  throw new Error(
    "Set TELEGRAM_NOTIFICATIONS_ENABLED=true, TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env",
  );
}

const service = createDefaultService(config, createDefaultKraken(config));
const reporter = new TelegramTradingReporter({
  botToken: config.telegramBotToken,
  chatId: config.telegramChatId,
  service,
});

const sent = await reporter.sendTest();
if (!sent) process.exitCode = 1;
else console.log("Telegram test notification sent");
