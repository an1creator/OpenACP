import type { TurnContext } from "./turn-context.js";

/** Public limit for a newly supplied manual session name. */
export const SESSION_NAME_MAX_LENGTH = 200;

/** Auto-generated and agent-provided names are intentionally concise. */
export const GENERATED_SESSION_NAME_MAX_WORDS = 5;

/** Display limit for auto-generated and agent-provided names. */
export const GENERATED_SESSION_NAME_MAX_LENGTH = 50;

/** Origin of the currently selected display name. */
export type SessionNameSource = "agent" | "auto" | "manual" | "persisted" | "system" | "placeholder";

/** Immutable ingress context captured when an ACP title event is received. */
export interface AgentTitleContext {
  turnId: string | null;
  userPrompt: string;
  finalPrompt: string;
  nameRevision: number;
}

export type AgentTitleDecision =
  | { status: "accepted"; name: string }
  | { status: "ignored"; reason: "empty" | "prompt_echo" | "manual_priority" | "stale" | "unchanged" };

function comparableText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/[\u00ad\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value;
  const pairs: Record<string, string> = {
    '"': '"',
    "'": "'",
    "`": "`",
    "“": "”",
    "‘": "’",
  };
  const closing = pairs[value[0] ?? ""];
  return closing && value.endsWith(closing) ? value.slice(1, -1).trim() : value;
}

function truncateCodePoints(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("").trim();
}

/** Normalize a newly supplied user-visible session name before persistence or delivery. */
export function normalizeSessionName(
  value: string,
  options: { generated?: boolean } = {},
): string {
  let normalized = stripWrappingQuotes(comparableText(value));
  if (options.generated) {
    normalized = normalized
      .split(" ")
      .slice(0, GENERATED_SESSION_NAME_MAX_WORDS)
      .join(" ");
  }
  normalized = truncateCodePoints(
    normalized,
    options.generated ? GENERATED_SESSION_NAME_MAX_LENGTH : SESSION_NAME_MAX_LENGTH,
  );
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(normalized) ? normalized : "";
}

/**
 * Restore a durable name without silently migrating its historical formatting or length.
 * New names still pass through normalizeSessionName(); this path is only for stored data.
 */
export function restoreSessionName(value: string): string {
  return /[\p{L}\p{N}\p{P}\p{S}]/u.test(comparableText(value)) ? value : "";
}

/** Capture prompt identity synchronously so delayed middleware cannot lose turn provenance. */
export function captureAgentTitleContext(
  turn: TurnContext | null,
  nameRevision: number,
): AgentTitleContext {
  return {
    turnId: turn?.turnId ?? null,
    userPrompt: turn?.userPrompt ?? "",
    finalPrompt: turn?.finalPrompt ?? "",
    nameRevision,
  };
}

/** True when an ACP title is the agent's fallback echo of the current user prompt. */
export function isPromptEcho(title: string, context: AgentTitleContext): boolean {
  const candidate = comparableText(title);
  if (!candidate || context.turnId === null) return false;
  const candidates = new Set([candidate, stripWrappingQuotes(candidate)]);
  return [context.userPrompt, context.finalPrompt]
    .map(comparableText)
    .some((prompt) => prompt.length > 0 && candidates.has(prompt));
}
