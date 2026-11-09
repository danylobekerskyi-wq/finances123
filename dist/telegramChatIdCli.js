import "dotenv/config";
const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
if (!token) {
    throw new Error("Set TELEGRAM_BOT_TOKEN in the local .env file first");
}
const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?limit=20&timeout=0`);
if (!response.ok) {
    throw new Error(`Telegram API returned HTTP ${response.status}`);
}
const body = (await response.json());
const chats = new Map();
for (const update of body.result || []) {
    const chat = update.message?.chat || update.channel_post?.chat;
    if (!chat)
        continue;
    const label = chat.title || chat.first_name || chat.username || chat.type || "chat";
    chats.set(chat.id, label);
}
if (chats.size === 0) {
    throw new Error("No Telegram chat found. Open your bot, send /start, then run this command again");
}
for (const [id, label] of chats)
    console.log(`${id}  ${label}`);
