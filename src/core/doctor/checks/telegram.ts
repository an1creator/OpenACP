/**
 * Doctor check: Telegram — validates bot token, chat ID, and bot permissions.
 *
 * Performs live API calls to verify:
 *   1. Bot token format matches Telegram's pattern
 *   2. Bot token is accepted by the Telegram API (getMe)
 *   3. Chat ID points to a valid supergroup with topics enabled
 *   4. Bot has administrator privileges in the group
 *
 * Skipped if Telegram is not configured (no bot token or chat ID in settings).
 */

import * as path from "node:path";
import type { DoctorCheck, CheckResult } from "../types.js";
import { redactNetworkSecrets } from "../../security/network-redaction.js";
import { TELEGRAM_COMMAND_LOCALES, effectiveTelegramGroupCommands } from "../../telegram-command-scopes.js";

/** Telegram bot tokens follow the pattern: <bot_id>:<alphanumeric_secret> */
const BOT_TOKEN_REGEX = /^\d+:[A-Za-z0-9_-]{35,}$/;

interface TelegramCommand {
  command: string;
  description: string;
}

type CommandScope =
  | { type: "default" }
  | { type: "all_group_chats" }
  | { type: "all_chat_administrators" }
  | { type: "chat"; chat_id: number }
  | { type: "chat_administrators"; chat_id: number };

export const telegramCheck: DoctorCheck = {
  name: "Telegram",
  order: 3,
  async run(ctx) {
    const results: CheckResult[] = [];

    if (!ctx.config) {
      results.push({ status: "fail", message: "Cannot check Telegram — config not loaded" });
      return results;
    }

    // Read Telegram settings from plugin settings (migrated out of config.json)
    const { SettingsManager } = await import("../../plugin/settings-manager.js");
    const sm = new SettingsManager(path.join(ctx.pluginsDir, "data"));
    const ps = await sm.loadSettings("@openacp/telegram");

    const botToken = ps.botToken as string | undefined;
    const chatId = ps.chatId as number | undefined;

    if (!botToken && !chatId) {
      results.push({ status: "pass", message: "Telegram not configured (skipped)" });
      return results;
    }

    if (!botToken || !BOT_TOKEN_REGEX.test(botToken)) {
      results.push({ status: "fail", message: "Bot token format invalid" });
      return results;
    }
    results.push({ status: "pass", message: "Bot token format valid" });

    let telegramFetch: typeof fetch;
    try {
      telegramFetch = ctx.fetchForScope("channels.telegram");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ status: "fail", message: `Cannot initialize Telegram transport: ${redactNetworkSecrets(message)}` });
      return results;
    }

    let botId: number | undefined;
    try {
      const res = await telegramFetch(`https://api.telegram.org/bot${botToken}/getMe`);
      const data = (await res.json()) as { ok: boolean; result?: { id: number; username: string }; description?: string };
      if (data.ok && data.result) {
        botId = data.result.id;
        results.push({ status: "pass", message: `Bot token valid (@${data.result.username})` });
      } else {
        results.push({ status: "fail", message: `Bot token rejected: ${data.description || "unknown error"}` });
        return results;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ status: "fail", message: `Cannot reach Telegram API: ${redactNetworkSecrets(message)}` });
      return results;
    }

    if (!chatId || chatId === 0) {
      results.push({ status: "fail", message: "Chat ID not configured" });
      return results;
    }

    try {
      const [{ TelegramCommandOwnershipStore, telegramCommandInstanceKey }, { getGlobalRoot }] = await Promise.all([
        import("../../../plugins/telegram/command-ownership-store.js"),
        import("../../instance/instance-context.js"),
      ]);
      const owner = new TelegramCommandOwnershipStore(getGlobalRoot()).getOwner(String(botId));
      if (owner && owner.instanceKey !== telegramCommandInstanceKey(ctx.dataDir)) {
        results.push({
          status: "warn",
          message: "Telegram command sync is owned by another OpenACP instance. Use a unique bot per instance. For a stopped same-host owner only, request one explicit takeover with OPENACP_TELEGRAM_COMMAND_TAKEOVER=1.",
        });
      }
    } catch (err) {
      results.push({
        status: "warn",
        message: `Cannot inspect Telegram command-sync ownership: ${redactNetworkSecrets(err instanceof Error ? err.message : String(err))}`,
      });
    }

    try {
      const res = await telegramFetch(`https://api.telegram.org/bot${botToken}/getChat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId }),
      });
      const data = (await res.json()) as {
        ok: boolean;
        result?: { type: string; is_forum?: boolean; title: string };
        description?: string;
      };
      if (!data.ok || !data.result) {
        results.push({ status: "fail", message: `Chat ID invalid: ${data.description || "unknown error"}` });
        return results;
      }
      if (data.result.type !== "supergroup") {
        results.push({ status: "fail", message: `Chat is "${data.result.type}", must be a supergroup` });
        return results;
      }
      if (!data.result.is_forum) {
        results.push({ status: "warn", message: "Chat does not have topics enabled" });
      } else {
        results.push({ status: "pass", message: `Chat is supergroup with topics ("${data.result.title}")` });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ status: "fail", message: `Cannot validate chat: ${redactNetworkSecrets(message)}` });
      return results;
    }

    try {
      const res = await telegramFetch(`https://api.telegram.org/bot${botToken}/getChatMember`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, user_id: botId }),
      });
      const data = (await res.json()) as { ok: boolean; result?: { status: string }; description?: string };
      if (!data.ok || !data.result) {
        results.push({ status: "fail", message: `Cannot check bot membership: ${data.description || "unknown"}` });
      } else if (data.result.status === "administrator" || data.result.status === "creator") {
        results.push({ status: "pass", message: "Bot is admin in group" });
      } else {
        results.push({
          status: "fail",
          message: `Bot is "${data.result.status}" — must be admin. Promote bot in group settings.`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({ status: "fail", message: `Admin check failed: ${redactNetworkSecrets(message)}` });
    }

    try {
      const getCommands = async (scope: CommandScope, languageCode: string): Promise<TelegramCommand[]> => {
        const res = await telegramFetch(`https://api.telegram.org/bot${botToken}/getMyCommands`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, ...(languageCode ? { language_code: languageCode } : {}) }),
        });
        const data = (await res.json()) as {
          ok: boolean;
          result?: TelegramCommand[];
          description?: string;
        };
        if (!data.ok || !Array.isArray(data.result)) {
          throw new Error(data.description || "Telegram returned an invalid command list");
        }
        return data.result;
      };

      const missing: string[] = [];
      for (const locale of TELEGRAM_COMMAND_LOCALES) {
        const [defaultCommands, groupCommands, globalAdminCommands, chatCommands, chatAdminCommands] =
          await Promise.all([
            getCommands({ type: "default" }, locale),
            getCommands({ type: "all_group_chats" }, locale),
            getCommands({ type: "all_chat_administrators" }, locale),
            getCommands({ type: "chat", chat_id: chatId }, locale),
            getCommands({ type: "chat_administrators", chat_id: chatId }, locale),
          ]);
        const lists = {
          default: defaultCommands,
          allGroup: groupCommands,
          allAdmins: globalAdminCommands,
          chat: chatCommands,
          chatAdmins: chatAdminCommands,
        };
        const localeName = locale || "neutral";
        if (!effectiveTelegramGroupCommands(lists, false).some((command) => command.command === "proxy")) missing.push(`${localeName} members`);
        if (!effectiveTelegramGroupCommands(lists, true).some((command) => command.command === "proxy")) missing.push(`${localeName} administrators`);
      }

      if (missing.length === 0) {
        results.push({ status: "pass", message: "Telegram command menus are synchronized for neutral/en/ru scopes (including /proxy)" });
      } else {
        results.push({
          status: "warn",
          message: `Telegram command menu is out of sync for ${missing.join(", ")} (missing /proxy). Restart OpenACP; if the warning remains, inspect Telegram connectivity logs.`,
        });
      }
    } catch (err) {
      const message = redactNetworkSecrets(err instanceof Error ? err.message : String(err));
      results.push({
        status: "warn",
        message: `Cannot verify Telegram command menus: ${message}. Restart OpenACP; if the warning remains, inspect Telegram connectivity logs.`,
      });
    }

    return results;
  },
};
