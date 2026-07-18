import { createHash } from "node:crypto";
import type { Bot } from "grammy";
import type { SendQueue } from "../../core/adapter-primitives/primitives/send-queue.js";
import type { AgentCommand, TelegramPlatformData } from "../../core/types.js";
import type { SessionManager } from "../../core/sessions/session-manager.js";
import { buildSkillKeyboard, buildSkillMessages } from "./commands/index.js";
import { createChildLogger } from "../../core/utils/log.js";

const log = createChildLogger({ module: "skill-commands" });

// Telegram accepts 1-4096 characters per message. buildSkillMessages() owns
// that split; this bound keeps one update and persisted recovery work finite.
const MAX_SKILL_MESSAGE_PARTS = 32;
const MAX_STALE_MESSAGE_IDS = 64;
const SESSION_ENDED_TEXT = "🛠 <i>Session ended</i>";
const REPLACED_TEXT = "🛠 <i>Agent command list updated</i>";

interface SkillMessageState {
  ids: number[];
  digest?: string;
  /** False for IDs restored from disk until the bot successfully edits them. */
  verified: boolean;
}

/**
 * Manages the pinned "Agent commands" message set in each session topic.
 *
 * A rendered command list can span multiple Telegram messages. Replacements
 * are staged completely, pinned, and persisted before the old set is retired.
 * The persisted stale-ID journal lets restart recovery finish interrupted
 * cleanup without treating an incomplete replacement as current.
 */
export class SkillCommandManager {
  private messages = new Map<string, SkillMessageState>();
  private operations = new Map<string, Promise<void>>();

  constructor(
    private bot: Bot,
    private chatId: number,
    private sendQueue: SendQueue,
    private sessionManager: SessionManager,
  ) {}

  async send(sessionId: string, threadId: number, commands: AgentCommand[]): Promise<void> {
    return this.runExclusive(sessionId, () => this.sendInternal(sessionId, threadId, commands));
  }

  async cleanup(sessionId: string): Promise<void> {
    return this.runExclusive(sessionId, () => this.cleanupInternal(sessionId));
  }

  private async runExclusive(sessionId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.operations.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    this.operations.set(sessionId, current);
    try {
      await current;
    } finally {
      if (this.operations.get(sessionId) === current) this.operations.delete(sessionId);
    }
  }

  private async sendInternal(
    sessionId: string,
    threadId: number,
    commands: AgentCommand[],
  ): Promise<void> {
    const restored = this.restore(sessionId);
    let state = restored.state;
    let staleIds = await this.recoverStale(sessionId, state, restored.staleIds);

    if (commands.length === 0) {
      await this.cleanupState(sessionId, state, staleIds);
      return;
    }

    const texts = buildSkillMessages(commands);
    if (texts.length === 0 || texts.length > MAX_SKILL_MESSAGE_PARTS) {
      log.error(
        { sessionId, parts: texts.length, limit: MAX_SKILL_MESSAGE_PARTS },
        "Agent command list exceeds bounded Telegram message-set limit",
      );
      return;
    }
    const keyboard = buildSkillKeyboard(commands);
    const digest = renderDigest(texts, keyboard);

    // A repeated update in the same process is a true no-op. After restart,
    // verify every persisted ID by editing it before considering it current.
    if (state?.digest === digest && state.ids.length === texts.length) {
      if (state.verified) return;
      if (await this.editMessageSet(state.ids, texts, keyboard)) {
        state = { ...state, verified: true };
        this.messages.set(sessionId, state);
        return;
      }
    }

    // A one-part set can be updated atomically in place. Any edit failure falls
    // back to a staged replacement while the old message remains untouched.
    if (state?.ids.length === 1 && texts.length === 1) {
      if (await this.editMessage(state.ids[0]!, texts[0]!, keyboard)) {
        try {
          await this.persist(sessionId, state.ids, digest, staleIds);
          state = { ids: state.ids, digest, verified: true };
          this.messages.set(sessionId, state);
          return;
        } catch (error) {
          log.error({ error, sessionId }, "Failed to persist edited agent command message");
          return;
        }
      }
    }

    const oldIds = state?.ids ?? [];
    const cleanupJournal = uniqueIds([...staleIds, ...oldIds], MAX_STALE_MESSAGE_IDS);
    if (staleIds.length + oldIds.length > MAX_STALE_MESSAGE_IDS) {
      log.error(
        { sessionId, stale: staleIds.length, current: oldIds.length, limit: MAX_STALE_MESSAGE_IDS },
        "Refusing to accumulate an unbounded agent-command cleanup journal",
      );
      return;
    }

    const stagedIds: number[] = [];
    try {
      for (const [index, text] of texts.entries()) {
        const message = await this.sendQueue.enqueue(() =>
          this.bot.api.sendMessage(this.chatId, text, {
            message_thread_id: threadId,
            parse_mode: "HTML",
            disable_notification: true,
            ...(index === 0 ? { reply_markup: keyboard } : {}),
          }),
        );
        const messageId = (message as { message_id?: unknown } | undefined)?.message_id;
        if (!isMessageId(messageId)) throw new Error("Telegram did not return a valid message ID");
        stagedIds.push(messageId);
      }

      await this.bot.api.pinChatMessage(this.chatId, stagedIds[0]!, {
        disable_notification: true,
      });
      await this.persist(sessionId, stagedIds, digest, cleanupJournal);
    } catch (error) {
      await this.rollbackStaged(stagedIds);
      log.error({ error, sessionId }, "Failed to stage agent command message set");
      return;
    }

    const newState: SkillMessageState = { ids: stagedIds, digest, verified: true };
    this.messages.set(sessionId, newState);

    const failedOld = await this.retireMessages(oldIds, state?.verified === true);
    const failedStale = await this.retireMessages(
      staleIds.filter((id) => !oldIds.includes(id)),
      false,
    );
    staleIds = uniqueIds([...failedOld, ...failedStale], MAX_STALE_MESSAGE_IDS);
    try {
      await this.persist(sessionId, stagedIds, digest, staleIds);
    } catch (error) {
      // The first persistence step already recorded the complete cleanup journal,
      // so a restart can safely retry even if narrowing that journal fails.
      log.error({ error, sessionId }, "Failed to finalize agent command cleanup journal");
    }
  }

  private async cleanupInternal(sessionId: string): Promise<void> {
    const restored = this.restore(sessionId);
    const staleIds = await this.recoverStale(sessionId, restored.state, restored.staleIds);
    await this.cleanupState(sessionId, restored.state, staleIds);
  }

  private async cleanupState(
    sessionId: string,
    state: SkillMessageState | undefined,
    staleIds: number[],
  ): Promise<void> {
    const failed: number[] = [];
    const currentIds = state?.ids ?? [];
    const firstId = currentIds[0];

    if (firstId) {
      let canUnpin = false;
      try {
        await this.bot.api.editMessageText(this.chatId, firstId, SESSION_ENDED_TEXT, {
          parse_mode: "HTML",
        });
        canUnpin = true;
      } catch (error) {
        if (isNotModified(error)) canUnpin = true;
        else if (!isMessageMissing(error)) failed.push(firstId);
      }
      if (canUnpin) {
        try {
          await this.bot.api.unpinChatMessage(this.chatId, firstId);
        } catch (error) {
          if (!isMessageMissing(error)) failed.push(firstId);
        }
      }
    }

    failed.push(...await this.retireMessages(currentIds.slice(1), state?.verified === true));
    failed.push(...await this.retireMessages(
      staleIds.filter((id) => !currentIds.includes(id)),
      false,
    ));
    this.messages.delete(sessionId);

    try {
      await this.persist(sessionId, [], undefined, uniqueIds(failed, MAX_STALE_MESSAGE_IDS));
    } catch (error) {
      log.error({ error, sessionId }, "Failed to persist agent command cleanup");
    }
  }

  /** Retry cleanup recorded by a replacement interrupted after persistence. */
  private async recoverStale(
    sessionId: string,
    state: SkillMessageState | undefined,
    staleIds: number[],
  ): Promise<number[]> {
    if (staleIds.length === 0) return [];
    const failed = await this.retireMessages(
      staleIds.filter((id) => !state?.ids.includes(id)),
      false,
    );
    try {
      await this.persist(sessionId, state?.ids ?? [], state?.digest, failed);
    } catch (error) {
      log.error({ error, sessionId }, "Failed to persist recovered agent command cleanup");
    }
    return failed;
  }

  private restore(sessionId: string): { state?: SkillMessageState; staleIds: number[] } {
    let state = this.messages.get(sessionId);
    const record = this.sessionManager.getSessionRecord(sessionId);
    const platform = record?.platform as TelegramPlatformData | undefined;
    if (!state && platform) {
      const ids = normalizePersistedIds(platform.skillMsgIds, platform.skillMsgId);
      if (ids.length > 0) {
        state = {
          ids,
          digest: typeof platform.skillMsgDigest === "string" ? platform.skillMsgDigest : undefined,
          verified: false,
        };
        this.messages.set(sessionId, state);
      }
    }
    return {
      state,
      staleIds: uniqueIds(platform?.skillStaleMsgIds ?? [], MAX_STALE_MESSAGE_IDS),
    };
  }

  private async persist(
    sessionId: string,
    ids: number[],
    digest: string | undefined,
    staleIds: number[],
  ): Promise<void> {
    const record = this.sessionManager.getSessionRecord(sessionId);
    if (!record) return;
    const platform = record.platform && typeof record.platform === "object"
      ? record.platform as Record<string, unknown>
      : {};
    const {
      skillMsgId: _legacy,
      skillMsgIds: _ids,
      skillMsgDigest: _digest,
      skillStaleMsgIds: _stale,
      ...rest
    } = platform;
    const normalizedIds = uniqueIds(ids, MAX_SKILL_MESSAGE_PARTS);
    const normalizedStale = uniqueIds(staleIds, MAX_STALE_MESSAGE_IDS)
      .filter((id) => !normalizedIds.includes(id));
    await this.sessionManager.patchRecord(sessionId, {
      platform: {
        ...rest,
        ...(normalizedIds.length > 0 ? {
          skillMsgId: normalizedIds[0],
          skillMsgIds: normalizedIds,
          ...(digest ? { skillMsgDigest: digest } : {}),
        } : {}),
        ...(normalizedStale.length > 0 ? { skillStaleMsgIds: normalizedStale } : {}),
      },
    });
  }

  private async editMessageSet(
    ids: number[],
    texts: string[],
    keyboard: ReturnType<typeof buildSkillKeyboard>,
  ): Promise<boolean> {
    for (const [index, id] of ids.entries()) {
      if (!await this.editMessage(id, texts[index]!, index === 0 ? keyboard : undefined)) return false;
    }
    return true;
  }

  private async editMessage(
    id: number,
    text: string,
    keyboard?: ReturnType<typeof buildSkillKeyboard>,
  ): Promise<boolean> {
    try {
      await this.bot.api.editMessageText(this.chatId, id, text, {
        parse_mode: "HTML",
        ...(keyboard ? { reply_markup: keyboard } : {}),
      });
      return true;
    } catch (error) {
      return isNotModified(error);
    }
  }

  /**
   * Retire only IDs known in memory or proven bot-owned by a successful edit.
   * This avoids deleting an unrelated message if persisted platform data is
   * corrupted while still allowing restart cleanup of managed messages.
   */
  private async retireMessages(ids: number[], trusted: boolean): Promise<number[]> {
    const failed: number[] = [];
    for (const id of uniqueIds(ids, MAX_STALE_MESSAGE_IDS)) {
      try {
        await this.bot.api.editMessageText(this.chatId, id, REPLACED_TEXT, {
          parse_mode: "HTML",
        });
      } catch (error) {
        if (isMessageMissing(error)) continue;
        if (!isNotModified(error) && !trusted) {
          failed.push(id);
          continue;
        }
      }
      try {
        await this.bot.api.unpinChatMessage(this.chatId, id);
      } catch { /* unpinned or already gone; deletion below is authoritative */ }
      try {
        await this.bot.api.deleteMessage(this.chatId, id);
      } catch (error) {
        if (!isMessageMissing(error)) failed.push(id);
      }
    }
    return failed;
  }

  private async rollbackStaged(ids: number[]): Promise<void> {
    for (const id of ids) {
      await this.bot.api.editMessageText(this.chatId, id, REPLACED_TEXT, {
        parse_mode: "HTML",
      }).catch(() => {});
    }
    if (ids.length > 0) {
      await this.bot.api.unpinChatMessage(this.chatId, ids[0]!).catch(() => {});
    }
    for (const id of ids) {
      await this.bot.api.deleteMessage(this.chatId, id).catch(() => {});
    }
  }
}

function renderDigest(
  texts: string[],
  keyboard: ReturnType<typeof buildSkillKeyboard>,
): string {
  return createHash("sha256").update(JSON.stringify({ texts, keyboard })).digest("hex");
}

function normalizePersistedIds(ids: unknown, legacyId: unknown): number[] {
  const complete = Array.isArray(ids) ? uniqueIds(ids, MAX_SKILL_MESSAGE_PARTS) : [];
  if (complete.length > 0) return complete;
  return isMessageId(legacyId) ? [legacyId] : [];
}

function uniqueIds(values: readonly unknown[], limit: number): number[] {
  const ids: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!isMessageId(value) || seen.has(value)) continue;
    ids.push(value);
    seen.add(value);
    if (ids.length >= limit) break;
  }
  return ids;
}

function isMessageId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
}

function isNotModified(error: unknown): boolean {
  return errorMessage(error).includes("message is not modified");
}

function isMessageMissing(error: unknown): boolean {
  const message = errorMessage(error);
  return message.includes("message to edit not found")
    || message.includes("message to delete not found")
    || message.includes("message not found")
    || message.includes("message_id_invalid");
}
