import type { Bot, Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { OpenACPCore } from "../../../core/index.js";
import { DoctorEngine } from "../../../core/doctor/index.js";
import type { DoctorReport, PendingFix } from "../../../core/doctor/types.js";
import { createChildLogger } from "../../../core/utils/log.js";
import { settingsCommandCallback } from "../callback-navigation.js";
import { doctorHeadline, doctorSummary } from "../../../core/doctor/format.js";

const log = createChildLogger({ module: "telegram-cmd-doctor" });

const pendingFixesStore = new Map<string, PendingFix[]>();
const TELEGRAM_REPORT_LIMIT = 3_900;
const SHORTENED_FOOTER = "…Output shortened. Run openacp doctor on the host for full details.";

function escapeHtmlToLimit(text: string, limit: number): string {
  if (limit <= 0) return "";
  const chunks: string[] = [];
  let length = 0;
  let shortened = false;
  for (const character of text) {
    const escaped = escapeHtml(character);
    if (length + escaped.length > limit) { shortened = true; break; }
    chunks.push(escaped);
    length += escaped.length;
  }
  if (!shortened) return chunks.join("");
  while (chunks.length && length + 1 > limit) length -= chunks.pop()!.length;
  return limit > 0 ? `${chunks.join("")}…` : "";
}

function renderTruncatedReport(report: DoctorReport, header: string[]): string {
  const icons = { pass: "✅", warn: "⚠️", fail: "❌" };
  const footer = `\n\n${SHORTENED_FOOTER}`;
  const budget = TELEGRAM_REPORT_LIMIT - footer.length;
  const lines = [...header];
  let length = lines.join("\n").length;
  const append = (line: string): boolean => {
    const added = (lines.length ? 1 : 0) + line.length;
    if (length + added > budget) return false;
    lines.push(line);
    length += added;
    return true;
  };

  outer: for (const category of report.categories.filter((item) => item.results.some((result) => result.status !== 'pass'))) {
    const remainingForCategory = budget - length - 1;
    const categoryText = escapeHtmlToLimit(category.name, Math.max(0, remainingForCategory - 7));
    if (!categoryText || !append(`<b>${categoryText}</b>`)) break;
    for (const result of category.results.filter((item) => item.status !== 'pass')) {
      const prefix = `  ${icons[result.status]} `;
      const remaining = budget - length - 1 - prefix.length;
      if (remaining <= 0) break outer;
      const message = escapeHtmlToLimit(result.message, remaining);
      if (!append(`${prefix}${message}`)) break outer;
      if (message !== escapeHtml(result.message)) break outer;
    }
    if (!append("")) break;
  }
  return `${lines.join("\n")}${footer}`;
}

export function renderReport(report: DoctorReport): { text: string; keyboard: InlineKeyboard | undefined } {
  const icons = { pass: "✅", warn: "⚠️", fail: "❌" };
  const { passed } = report.summary;
  const header = ["🩺 <b>OpenACP Doctor</b>", `<b>${doctorHeadline(report.summary)}</b>`, doctorSummary(report.summary, ' · '), ""];
  const lines: string[] = [...header];

  for (const category of report.categories.filter((item) => item.results.some((result) => result.status !== 'pass'))) {
    lines.push(`<b>${escapeHtml(category.name)}</b>`);
    for (const result of category.results.filter((item) => item.status !== 'pass')) {
      lines.push(`  ${icons[result.status]} ${escapeHtml(result.message)}`);
    }
    lines.push("");
  }
  if (passed) lines.push(`✅ ${passed} passed`);

  const keyboard = new InlineKeyboard();
  if (report.pendingFixes.length > 0) {
    for (let i = 0; i < report.pendingFixes.length; i++) {
      const label = `🔧 Fix: ${report.pendingFixes[i].message.slice(0, 30)}`;
      keyboard.text(label, `m:doctor:fix:${i}`).row();
    }
  }
  keyboard.text('Run again', 'm:doctor').row();
  keyboard.text('Speech-to-text settings', settingsCommandCallback('/speech')).row();
  keyboard.text('Network proxy settings', settingsCommandCallback('/proxy'));

  const text = lines.join("\n");
  return { text: text.length <= TELEGRAM_REPORT_LIMIT ? text : renderTruncatedReport(report, header), keyboard };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Handle `/doctor` — run all system diagnostic checks and display the report.
 *
 * Sends an initial "running…" message, runs `DoctorEngine.runAll()`, then
 * edits the message with the report. Pending fixes are stored per-message so
 * the `m:doctor:fix:<index>` callbacks know which fixes to apply.
 */
export async function handleDoctor(ctx: Context, core: OpenACPCore): Promise<void> {
  const statusMsg = await ctx.reply("🩺 Running diagnostics...", { parse_mode: "HTML" });

  try {
    const engine = new DoctorEngine({ dataDir: core.instanceContext.root });
    const report = await engine.runAll();
    const { text, keyboard } = renderReport(report);

    const storeKey = `${ctx.chat!.id}:${statusMsg.message_id}`;
    if (report.pendingFixes.length > 0) {
      pendingFixesStore.set(storeKey, report.pendingFixes);
    }

    await ctx.api.editMessageText(ctx.chat!.id, statusMsg.message_id, text, {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
  } catch (err) {
    log.error({ err }, "Doctor command failed");
    await ctx.api.editMessageText(
      ctx.chat!.id,
      statusMsg.message_id,
      `❌ Diagnostics could not finish. Check the OpenACP logs, then run the checks again.`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text('Run again', 'm:doctor') },
    );
  }
}

export function setupDoctorCallbacks(bot: Bot, core: OpenACPCore): void {
  bot.callbackQuery(/^m:doctor:fix:/, async (ctx) => {
    const data = ctx.callbackQuery.data;
    const index = parseInt(data.replace("m:doctor:fix:", ""), 10);
    const chatId = ctx.callbackQuery.message?.chat.id;
    const messageId = ctx.callbackQuery.message?.message_id;

    try {
      await ctx.answerCallbackQuery({ text: "Applying fix..." });
    } catch { /* expired */ }

    if (chatId === undefined || messageId === undefined) return;

    const storeKey = `${chatId}:${messageId}`;
    const fixes = pendingFixesStore.get(storeKey);
    if (!fixes || index < 0 || index >= fixes.length) {
      try { await ctx.answerCallbackQuery({ text: "Fix no longer available" }); } catch { /* */ }
      return;
    }

    const pending = fixes[index];
    try {
      const result = await pending.fix();
      if (result.success) {
        const engine = new DoctorEngine({ dataDir: core.instanceContext.root });
        const report = await engine.runAll();
        const { text, keyboard } = renderReport(report);

        if (report.pendingFixes.length > 0) {
          pendingFixesStore.set(storeKey, report.pendingFixes);
        } else {
          pendingFixesStore.delete(storeKey);
        }

        await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: keyboard });
      } else {
        try { await ctx.answerCallbackQuery({ text: `Fix failed: ${result.message}` }); } catch { /* */ }
      }
    } catch (err) {
      log.error({ err, index }, "Doctor fix callback failed");
    }
  });

  bot.callbackQuery("m:doctor", async (ctx) => {
    try { await ctx.answerCallbackQuery(); } catch { /* */ }
    await handleDoctor(ctx, core);
  });
}
