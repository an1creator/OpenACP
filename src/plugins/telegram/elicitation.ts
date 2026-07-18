import { InlineKeyboard, type Bot, type Context } from "grammy";
import { nanoid } from "nanoid";
import type {
  ElicitationContentValue,
  ElicitationRequest,
  ElicitationResolvedEvent,
  Session,
} from "../../core/index.js";
import { ElicitationValidationError, elicitationStringOptions, validateElicitationField } from "../../core/sessions/elicitation-gate.js";
import { escapeHtml } from "./formatting.js";

interface PendingForm {
  key: string;
  request: ElicitationRequest;
  fieldIds: string[];
  fieldIndex: number;
  content: Record<string, ElicitationContentValue>;
  selected: Set<string>;
  chatId: number;
  topicId: number;
  ownerUserId?: string;
  messageId?: number;
  promptMessageId?: number;
  actionMessageId?: number;
  transitionTail: Promise<void>;
  processedCallbackIds: Set<string>;
}

const TELEGRAM_FORM_OPERATION_TIMEOUT_MS = 10_000;
const TELEGRAM_FORM_CLEANUP_TIMEOUT_MS = 2_000;

function callbackData(form: PendingForm, action: string, index?: number): string {
  return `e:${form.key}:${form.fieldIndex}:${action}${index === undefined ? "" : `:${index}`}`;
}

function requestKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`;
}

function fieldOptions(field: Record<string, unknown>): Array<{ value: string; label: string }> {
  if (field.type === "string") return elicitationStringOptions(field) ?? [];
  const items = field.items;
  if (!items || typeof items !== "object") return [];
  const itemSchema = items as Record<string, unknown>;
  if (Array.isArray(itemSchema.anyOf)) {
    return itemSchema.anyOf.flatMap((option) => {
      if (!option || typeof option !== "object") return [];
      const value = (option as { const?: unknown }).const;
      if (typeof value !== "string") return [];
      const title = (option as { title?: unknown }).title;
      return [{ value, label: typeof title === "string" ? title : value }];
    });
  }
  return Array.isArray(itemSchema.enum)
    ? itemSchema.enum.filter((value): value is string => typeof value === "string")
      .map((value) => ({ value, label: value }))
    : [];
}

/** Telegram renderer and responder for transient ACP form elicitation. */
export class TelegramElicitationHandler {
  private readonly forms = new Map<string, PendingForm>();
  private readonly requestKeys = new Map<string, string>();
  private readonly textInputs = new Map<string, string>();

  constructor(
    private readonly bot: Bot,
    private readonly chatId: number,
    private readonly getSession: (sessionId: string) => Session | undefined,
  ) {}

  setupHandlers(): void {
    this.bot.on("message:text", async (ctx, next) => {
      const topicId = ctx.message.message_thread_id;
      const userId = ctx.from?.id;
      if (topicId === undefined || userId === undefined) return next();
      const replyMessageId = ctx.message.reply_to_message?.message_id;
      if (replyMessageId === undefined) return next();
      const inputKey = `${ctx.chat.id}:${topicId}:${replyMessageId}`;
      const formKey = this.textInputs.get(inputKey);
      const form = formKey ? this.forms.get(formKey) : undefined;
      if (!form || replyMessageId !== form.promptMessageId) return next();
      if (!this.isCurrent(form)) {
        await this.clearFieldMarkup(form, false);
        this.removeForm(form);
        await ctx.reply("This input request has expired.").catch(() => {});
        return;
      }
      if (form.ownerUserId && form.ownerUserId !== String(userId)) {
        await ctx.reply("This input request belongs to another user.").catch(() => {});
        return;
      }
      const expectedFieldIndex = form.fieldIndex;
      const expectedPromptMessageId = form.promptMessageId;
      await this.withFormLock(form, async () => {
        if (
          !this.isCurrent(form)
          || form.fieldIndex !== expectedFieldIndex
          || form.promptMessageId !== expectedPromptMessageId
        ) {
          await ctx.reply("This field is no longer active.").catch(() => {});
          return;
        }
        const fieldId = form.fieldIds[form.fieldIndex];
        const field = this.field(form, fieldId);
        const secret = form.request.sensitiveFields?.includes(fieldId) === true;
        if (secret) {
          try {
            await ctx.deleteMessage();
          } catch {
            await this.failForm(form);
            await ctx.reply("I could not securely remove that message, so its value was not used. The input request was cancelled.").catch(() => {});
            return;
          }
        }

        let value: ElicitationContentValue;
        try {
          const raw = ctx.message.text;
          if (field.type === "number" || field.type === "integer") {
            value = Number(raw);
            if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) {
              throw new ElicitationValidationError(`Enter a valid ${field.type}.`);
            }
          } else {
            value = raw;
          }
          validateElicitationField(form.request, fieldId, value);
        } catch (error) {
          await ctx.reply(error instanceof Error ? error.message : "Invalid value. Please retry.").catch(() => {});
          await this.runTransition(form, async () => {
            await this.clearFieldMarkup(form, true);
            form.messageId = undefined;
            form.promptMessageId = undefined;
            form.actionMessageId = undefined;
            await this.present(form);
          });
          return;
        }
        form.content[fieldId] = value;
        this.textInputs.delete(inputKey);
        form.promptMessageId = undefined;
        await this.runTransition(form, () => this.advance(form));
      });
    });

    this.bot.on("callback_query:data", async (ctx, next) => {
      const data = ctx.callbackQuery.data;
      if (!data.startsWith("e:")) return next();
      const [, key, rawFieldIndex, action, rawIndex] = data.split(":");
      const form = this.forms.get(key);
      if (!form || !this.isCurrent(form)) {
        if (form) {
          await this.clearFieldMarkup(form, false);
          this.removeForm(form);
        }
        await this.answerCallback(ctx, { text: "Input request expired" });
        return;
      }
      const topicId = ctx.callbackQuery.message?.message_thread_id;
      if (
        ctx.chat?.id !== form.chatId
        || topicId !== form.topicId
        || (form.ownerUserId && form.ownerUserId !== String(ctx.from.id))
      ) {
        await this.answerCallback(ctx, { text: "This input request belongs to another user" });
        return;
      }
      const expectedFieldIndex = Number(rawFieldIndex);
      const callbackId = typeof ctx.callbackQuery.id === "string" ? ctx.callbackQuery.id : undefined;
      await this.withFormLock(form, async () => {
        if (!this.isCurrent(form) || expectedFieldIndex !== form.fieldIndex) {
          await this.answerCallback(ctx, { text: "This field is no longer active" });
          return;
        }
        if (callbackId && form.processedCallbackIds.has(callbackId)) {
          await this.answerCallback(ctx);
          return;
        }
        if (callbackId) form.processedCallbackIds.add(callbackId);
        if (action === "cancel") {
          this.getSession(form.request.sessionId)?.elicitationGate.cancel(form.request.id, "cancelled");
          await this.answerCallback(ctx, { text: "Cancelled" });
          return;
        }
        const fieldId = form.fieldIds[form.fieldIndex];
        const field = this.field(form, fieldId);
        const required = new Set(form.request.requestedSchema.required ?? []).has(fieldId);
        if (action === "skip") {
          if (required) {
            await this.answerCallback(ctx, { text: "This field is required" });
            return;
          }
          delete form.content[fieldId];
          await this.answerCallback(ctx);
          await this.runTransition(form, () => this.advance(form));
          return;
        }
        const index = Number(rawIndex);
        const options = fieldOptions(field);
        if (action === "value" && Number.isInteger(index) && options[index]) {
          try {
            validateElicitationField(form.request, fieldId, options[index].value);
            form.content[fieldId] = options[index].value;
          } catch (error) {
            await this.answerCallback(ctx, { text: error instanceof Error ? error.message : "Invalid value" });
            return;
          }
          await this.answerCallback(ctx);
          await this.runTransition(form, () => this.advance(form));
          return;
        }
        if (action === "bool" && (rawIndex === "0" || rawIndex === "1")) {
          const value = rawIndex === "1";
          try {
            validateElicitationField(form.request, fieldId, value);
            form.content[fieldId] = value;
          } catch (error) {
            await this.answerCallback(ctx, { text: error instanceof Error ? error.message : "Invalid value" });
            return;
          }
          await this.answerCallback(ctx);
          await this.runTransition(form, () => this.advance(form));
          return;
        }
        if (action === "toggle" && Number.isInteger(index) && options[index]) {
          const value = options[index].value;
          if (form.selected.has(value)) form.selected.delete(value);
          else form.selected.add(value);
          await this.answerCallback(ctx);
          await this.runTransition(form, () => this.present(form, ctx));
          return;
        }
        if (action === "submit") {
          const value = [...form.selected];
          try {
            validateElicitationField(form.request, fieldId, value);
            form.content[fieldId] = value;
          } catch (error) {
            await this.answerCallback(ctx, { text: error instanceof Error ? error.message : "Invalid value" });
            return;
          }
          await this.answerCallback(ctx);
          await this.runTransition(form, () => this.advance(form));
          return;
        }
        await this.answerCallback(ctx, { text: "Invalid input action" });
      });
    });
  }

  async send(session: Session, request: ElicitationRequest): Promise<void> {
    const topicId = Number(session.threadIds.get("telegram") ?? session.threadId);
    if (!Number.isInteger(topicId) || topicId <= 0) throw new Error("Telegram topic is unavailable");
    const form: PendingForm = {
      key: nanoid(8),
      request,
      fieldIds: Object.keys(request.requestedSchema.properties ?? {}),
      fieldIndex: 0,
      content: {},
      selected: new Set(),
      chatId: this.chatId,
      topicId,
      ownerUserId: request.owner?.userId,
      transitionTail: Promise.resolve(),
      processedCallbackIds: new Set(),
    };
    this.forms.set(form.key, form);
    this.requestKeys.set(requestKey(request.sessionId, request.id), form.key);
    if (form.fieldIds.length === 0) {
      session.elicitationGate.resolve(request.id, { action: "accept", content: {} }, "telegram");
      return;
    }
    try {
      await this.present(form);
    } catch (error) {
      await this.failForm(form);
      throw error;
    }
  }

  async dismiss(event: ElicitationResolvedEvent): Promise<void> {
    const key = this.requestKeys.get(requestKey(event.sessionId, event.requestId));
    const form = key ? this.forms.get(key) : undefined;
    if (
      !form
      || form.request.sessionId !== event.sessionId
      || form.request.id !== event.requestId
    ) return;
    await this.clearFieldMarkup(form, false);
    this.removeForm(form);
  }

  clear(): void {
    this.forms.clear();
    this.requestKeys.clear();
    this.textInputs.clear();
  }

  private isCurrent(form: PendingForm): boolean {
    return this.getSession(form.request.sessionId)?.elicitationGate.get(form.request.id) !== undefined;
  }

  private async answerCallback(ctx: Context, options?: Parameters<Context["answerCallbackQuery"]>[0]): Promise<void> {
    try {
      await ctx.answerCallbackQuery(options);
    } catch {
      // Callback acknowledgement is best-effort; the gate remains authoritative.
    }
  }

  private field(form: PendingForm, fieldId: string): Record<string, unknown> {
    return (form.request.requestedSchema.properties?.[fieldId] ?? {}) as Record<string, unknown>;
  }

  private removeForm(form: PendingForm): void {
    this.forms.delete(form.key);
    this.requestKeys.delete(requestKey(form.request.sessionId, form.request.id));
    for (const [key, value] of this.textInputs) if (value === form.key) this.textInputs.delete(key);
  }

  private async withFormLock(form: PendingForm, operation: () => Promise<void>): Promise<void> {
    const predecessor = form.transitionTail.catch(() => undefined);
    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    form.transitionTail = predecessor.then(() => completed);
    await predecessor;
    try {
      await operation();
    } finally {
      release();
    }
  }

  private async runTransition(form: PendingForm, operation: () => Promise<void>): Promise<boolean> {
    try {
      await operation();
      return true;
    } catch {
      await this.failForm(form);
      return false;
    }
  }

  private async failForm(form: PendingForm): Promise<void> {
    if (!this.forms.has(form.key)) return;
    // Partial answers are transient and must never survive a delivery failure.
    form.content = {};
    form.selected.clear();
    await this.clearFieldMarkup(form, false);
    this.removeForm(form);
    this.getSession(form.request.sessionId)?.elicitationGate.cancel(form.request.id, "delivery_failed");
  }

  private async advance(form: PendingForm): Promise<void> {
    await this.clearFieldMarkup(form, true);
    form.fieldIndex += 1;
    form.selected = new Set();
    form.messageId = undefined;
    form.promptMessageId = undefined;
    form.actionMessageId = undefined;
    if (form.fieldIndex < form.fieldIds.length) {
      await this.present(form);
      return;
    }
    const session = this.getSession(form.request.sessionId);
    if (!session) throw new Error("Session is unavailable");
    session.elicitationGate.resolve(
      form.request.id,
      { action: "accept", content: form.content },
      "telegram",
    );
  }

  private async present(form: PendingForm, callbackContext?: Context): Promise<void> {
    if (!this.isCurrent(form)) return;
    const fieldId = form.fieldIds[form.fieldIndex];
    const field = this.field(form, fieldId);
    const title = typeof field.title === "string" ? field.title : fieldId;
    const description = typeof field.description === "string" ? `\n${escapeHtml(field.description)}` : "";
    const required = new Set(form.request.requestedSchema.required ?? []).has(fieldId);
    const heading = `💬 <b>${escapeHtml(form.request.message)}</b>\n\n<b>${escapeHtml(title)}</b>${description}`;
    const keyboard = new InlineKeyboard();
    const options = fieldOptions(field);
    if (field.type === "string" && options.length > 0) {
      options.forEach((option, index) => keyboard.text(option.label.slice(0, 50), callbackData(form, "value", index)).row());
    } else if (field.type === "boolean") {
      keyboard.text("Yes", callbackData(form, "bool", 1)).text("No", callbackData(form, "bool", 0)).row();
    } else if (field.type === "array") {
      options.forEach((option, index) => {
        keyboard.text(`${form.selected.has(option.value) ? "✅" : "◻️"} ${option.label}`.slice(0, 50), callbackData(form, "toggle", index)).row();
      });
      keyboard.text("Submit", callbackData(form, "submit")).row();
    } else {
      if (form.request.sensitiveFields?.includes(fieldId) && field.type !== "string") {
        this.getSession(form.request.sessionId)?.elicitationGate.cancel(form.request.id, "delivery_failed");
        return;
      }
      const prompt = await this.boundedOperation(this.bot.api.sendMessage(form.chatId, `${heading}\n\nReply to this message with the value.`, {
        message_thread_id: form.topicId,
        parse_mode: "HTML",
        reply_markup: { force_reply: true, selective: true },
      }), TELEGRAM_FORM_OPERATION_TIMEOUT_MS);
      form.promptMessageId = prompt.message_id;
      form.messageId = prompt.message_id;
      const inputKey = `${form.chatId}:${form.topicId}:${prompt.message_id}`;
      this.textInputs.set(inputKey, form.key);
      const actions = new InlineKeyboard();
      if (!required) actions.text("Skip", callbackData(form, "skip"));
      actions.text("Cancel", callbackData(form, "cancel"));
      const actionMessage = await this.boundedOperation(this.bot.api.sendMessage(form.chatId, required ? "This field is required." : "This field is optional.", {
        message_thread_id: form.topicId,
        reply_markup: actions,
      }), TELEGRAM_FORM_OPERATION_TIMEOUT_MS);
      form.actionMessageId = actionMessage.message_id;
      return;
    }
    if (!required) keyboard.text("Skip", callbackData(form, "skip"));
    keyboard.text("Cancel", callbackData(form, "cancel"));
    if (callbackContext) {
      await this.boundedOperation(
        callbackContext.editMessageText(heading, { parse_mode: "HTML", reply_markup: keyboard }),
        TELEGRAM_FORM_OPERATION_TIMEOUT_MS,
      );
      return;
    }
    const message = await this.boundedOperation(this.bot.api.sendMessage(form.chatId, heading, {
      message_thread_id: form.topicId,
      parse_mode: "HTML",
      reply_markup: keyboard,
    }), TELEGRAM_FORM_OPERATION_TIMEOUT_MS);
    form.messageId = message.message_id;
  }

  private async boundedOperation<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        callback();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error("Telegram form operation timed out"))),
        timeoutMs,
      );
      void operation.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    });
  }

  private async clearFieldMarkup(form: PendingForm, strict: boolean): Promise<void> {
    const messageIds = new Set([form.messageId, form.promptMessageId, form.actionMessageId]);
    const operations = [...messageIds].flatMap((messageId) => messageId === undefined ? [] : [
      this.boundedOperation(
        this.bot.api.editMessageReplyMarkup(form.chatId, messageId, { reply_markup: undefined }),
        strict ? TELEGRAM_FORM_OPERATION_TIMEOUT_MS : TELEGRAM_FORM_CLEANUP_TIMEOUT_MS,
      ),
    ]);
    if (strict) {
      await Promise.all(operations);
    } else {
      await Promise.all(operations.map((operation) => operation.catch(() => undefined)));
    }
  }
}
