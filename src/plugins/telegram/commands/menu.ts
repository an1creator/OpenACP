import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { AgentCommand } from "../../../core/index.js";
import type { MenuRegistry } from "../../../core/menu-registry.js";
import { createHash } from "node:crypto";
import { escapeHtml } from "../formatting.js";

/**
 * Build the main OpenACP menu keyboard from the MenuRegistry.
 * Falls back to a hardcoded keyboard when the registry is not available.
 * Items are grouped by their `group` property, with a row break between groups.
 */
export function buildMenuKeyboard(menuRegistry?: MenuRegistry): InlineKeyboard {
  if (!menuRegistry) {
    return new InlineKeyboard()
      .text('🆕 New Session', 'm:core:new')
      .text('📋 Sessions', 'm:core:sessions')
      .row()
      .text('📊 Status', 'm:core:status')
      .text('🤖 Agents', 'm:core:agents')
      .row()
      .text('❓ Help', 'm:core:help')
  }

  const items = menuRegistry.getItems()
  const kb = new InlineKeyboard()
  let currentGroup: string | undefined
  let rowCount = 0

  for (const item of items) {
    if (item.group !== currentGroup && rowCount > 0) {
      kb.row()
      rowCount = 0
    }
    currentGroup = item.group
    if (rowCount >= 2) {
      kb.row()
      rowCount = 0
    }
    kb.text(item.label, `m:${item.id}`)
    rowCount++
  }

  return kb
}

export async function handleMenu(ctx: Context, menuRegistry?: MenuRegistry): Promise<void> {
  await ctx.reply(`<b>OpenACP Menu</b>\nChoose an action:`, {
    parse_mode: "HTML",
    reply_markup: buildMenuKeyboard(menuRegistry),
  });
}

export async function handleHelp(ctx: Context): Promise<void> {
  await ctx.reply(
    `📖 <b>OpenACP Help</b>\n\n` +
      `🚀 <b>Getting Started</b>\n` +
      `Tap 🆕 New Session to start coding with AI.\n` +
      `Each session gets its own topic — chat there to work with the agent.\n\n` +
      `💡 <b>Common Tasks</b>\n` +
      `/new [agent] [workspace] — Create new session\n` +
      `/cancel — Cancel session (in session topic)\n` +
      `/status — Show session or system status\n` +
      `/sessions — List all sessions\n` +
      `/agents — Browse & install agents\n` +
      `/install &lt;name&gt; — Install an agent\n\n` +
      `⚙️ <b>System</b>\n` +
      `/restart — Restart OpenACP\n` +
      `/update — Update to latest version\n` +
      `/integrate — Manage agent integrations\n` +
      `/menu — Show action menu\n\n` +
      `🔒 <b>Session Options</b>\n` +
      `/bypass_permissions — Toggle bypass permissions\n` +
      `/handoff — Continue session in terminal\n` +
      `/archive — Archive session topic\n\n` +
      `💬 Need help? Just ask me in this topic!`,
    { parse_mode: "HTML" },
  );
}


const TELEGRAM_MSG_LIMIT = 4096;

/**
 * Build agent command messages. Each command is on its own line and the matching
 * action button is built separately. If the list exceeds Telegram's message
 * limit, it is split into multiple messages (cut at line boundaries).
 */
export function buildSkillMessages(commands: AgentCommand[]): string[] {
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  const header = "🛠 <b>Agent commands</b>\n<i>These actions are sent to the current ACP agent.</i>\n";
  const lines = sorted.map((command) => {
    const name = escapeHtml(formatAgentCommandText(command.name).slice(0, 128));
    const description = command.description.trim().slice(0, 512);
    return `<code>${name}</code>${description ? ` — ${escapeHtml(description)}` : ""}`;
  });

  const messages: string[] = [];
  let current = header;

  for (const line of lines) {
    const candidate = current + "\n" + line;
    if (candidate.length > TELEGRAM_MSG_LIMIT) {
      messages.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) messages.push(current);
  return messages;
}

/** Return a command name without an optional ACP-style leading slash. */
export function normalizeAgentCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

/** Format an advertised ACP command with exactly one leading slash. */
export function formatAgentCommandText(name: string, input?: string): string {
  const command = `/${normalizeAgentCommandName(name)}`;
  const suffix = input?.trim();
  return suffix ? `${command} ${suffix}` : command;
}

/** Build a callback namespace that cannot collide with CommandRegistry callbacks. */
export function encodeAgentCommandCallback(name: string): string {
  const normalized = normalizeAgentCommandName(name);
  const encoded = Buffer.from(normalized, "utf8").toString("base64url");
  const direct = `a/${encoded}`;
  if (Buffer.byteLength(direct, "utf8") <= 64) return direct;
  return `a/#${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}

/** Resolve a callback only against the session's current advertised command snapshot. */
export function resolveAgentCommandCallback(
  data: string,
  commands: readonly AgentCommand[],
): AgentCommand | undefined {
  if (!data.startsWith("a/")) return undefined;
  const token = data.slice(2);
  if (token.startsWith("#")) {
    const matches = commands.filter((command) =>
      createHash("sha256")
        .update(normalizeAgentCommandName(command.name))
        .digest("hex")
        .startsWith(token.slice(1)),
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  try {
    const name = Buffer.from(token, "base64url").toString("utf8");
    return commands.find((command) => normalizeAgentCommandName(command.name) === name);
  } catch {
    return undefined;
  }
}

/** Build buttons whose `a/` callback namespace means "send to ACP agent". */
export function buildSkillKeyboard(commands: readonly AgentCommand[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const command of [...commands].sort((a, b) => a.name.localeCompare(b.name))) {
    keyboard
      .text(formatAgentCommandText(command.name).slice(0, 64), encodeAgentCommandCallback(command.name))
      .row();
  }
  return keyboard;
}
