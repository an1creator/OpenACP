import type {
  ElicitationContentValue,
  ElicitationRequest,
  ElicitationResolvedEvent,
  ElicitationResponse,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const MAX_PENDING = 8;
const MAX_SETTLED = 64;
const MAX_FIELDS = 20;
const MAX_OPTIONS = 100;
const MAX_MESSAGE_LENGTH = 4_000;
const MAX_TEXT_LENGTH = 32_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

interface PendingEntry {
  request: ElicitationRequest;
  resolve: (response: ElicitationResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type ElicitationResolveResult = "resolved" | "not_found" | "already_resolved";

/** Boundary error for malformed schemas or submitted form content. */
export class ElicitationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ElicitationValidationError";
  }
}

export interface ElicitationStringOption {
  value: string;
  label: string;
}

/**
 * Normalize ACP string choices once for every presentation and validation surface.
 * When both JSON Schema constraints are present, a value must satisfy both, so the
 * effective choices are their intersection while oneOf titles remain display labels.
 */
export function elicitationStringOptions(
  schema: Record<string, unknown>,
): ElicitationStringOption[] | undefined {
  const enumValues = Array.isArray(schema.enum)
    ? schema.enum.filter((value): value is string => typeof value === "string")
    : undefined;
  const oneOfValues = Array.isArray(schema.oneOf)
    ? schema.oneOf.flatMap((option): ElicitationStringOption[] => {
        if (!option || typeof option !== "object") return [];
        const value = (option as { const?: unknown }).const;
        if (typeof value !== "string") return [];
        const title = (option as { title?: unknown }).title;
        return [{ value, label: typeof title === "string" ? title : value }];
      })
    : undefined;

  if (enumValues && oneOfValues) {
    const allowed = new Set(enumValues);
    return oneOfValues.filter((option) => allowed.has(option.value));
  }
  if (oneOfValues) return oneOfValues;
  if (enumValues) return enumValues.map((value) => ({ value, label: value }));
  return undefined;
}

function enumValues(schema: Record<string, unknown>): string[] | undefined {
  return elicitationStringOptions(schema)?.map((option) => option.value);
}

function multiValues(schema: Record<string, unknown>): string[] {
  const items = schema.items;
  if (!items || typeof items !== "object") return [];
  const itemSchema = items as Record<string, unknown>;
  if (Array.isArray(itemSchema.enum)) {
    return itemSchema.enum.filter((value): value is string => typeof value === "string");
  }
  if (Array.isArray(itemSchema.anyOf)) {
    return itemSchema.anyOf.map((option) => (
      typeof option === "object" && option !== null && typeof (option as { const?: unknown }).const === "string"
        ? (option as { const: string }).const
        : ""
    )).filter(Boolean);
  }
  return [];
}

function assertBoundedText(value: unknown, label: string, max = MAX_TEXT_LENGTH): asserts value is string {
  if (typeof value !== "string" || value.length > max) {
    throw new ElicitationValidationError(`${label} must be a string of at most ${max} characters`);
  }
}

/** Validate the flat primitive schema supported by ACP form elicitation. */
export function validateElicitationRequest(request: ElicitationRequest): void {
  assertBoundedText(request.message, "message", MAX_MESSAGE_LENGTH);
  const schema = request.requestedSchema as Record<string, unknown>;
  if (schema.type !== undefined && schema.type !== "object") {
    throw new ElicitationValidationError("requestedSchema.type must be object");
  }
  const properties = schema.properties;
  if (properties !== undefined && (typeof properties !== "object" || properties === null || Array.isArray(properties))) {
    throw new ElicitationValidationError("requestedSchema.properties must be an object");
  }
  const entries = Object.entries((properties ?? {}) as Record<string, unknown>);
  if (entries.length > MAX_FIELDS) throw new ElicitationValidationError(`Form exceeds ${MAX_FIELDS} fields`);

  for (const [fieldId, raw] of entries) {
    assertBoundedText(fieldId, "field id", 200);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new ElicitationValidationError(`Invalid schema for field ${fieldId}`);
    }
    const field = raw as Record<string, unknown>;
    if (!new Set(["string", "number", "integer", "boolean", "array"]).has(String(field.type))) {
      throw new ElicitationValidationError(`Unsupported field type for ${fieldId}`);
    }
    if (typeof field.title === "string") assertBoundedText(field.title, `${fieldId}.title`, 500);
    if (typeof field.description === "string") assertBoundedText(field.description, `${fieldId}.description`, 2_000);
    if (field.type === "string") {
      const values = enumValues(field);
      if (values && (values.length === 0 || values.length > MAX_OPTIONS)) {
        throw new ElicitationValidationError(`Invalid options for ${fieldId}`);
      }
      if (field.pattern !== undefined) {
        throw new ElicitationValidationError(`String patterns are not supported for ${fieldId}`);
      }
    }
    if (field.type === "array") {
      const values = multiValues(field);
      if (values.length === 0 || values.length > MAX_OPTIONS) {
        throw new ElicitationValidationError(`Invalid multi-select options for ${fieldId}`);
      }
    }
  }

  const required = schema.required;
  if (required !== undefined && required !== null) {
    if (!Array.isArray(required) || required.some((field) => typeof field !== "string" || !(field in (properties ?? {})))) {
      throw new ElicitationValidationError("required must reference declared fields");
    }
  }
}

function validateStringFormat(value: string, format: unknown, fieldId: string): void {
  if (format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new ElicitationValidationError(`${fieldId} must be an email address`);
  }
  if (format === "uri") {
    try { new URL(value); } catch { throw new ElicitationValidationError(`${fieldId} must be a URI`); }
  }
  if (format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ElicitationValidationError(`${fieldId} must be a date`);
  }
  if (format === "date-time" && Number.isNaN(Date.parse(value))) {
    throw new ElicitationValidationError(`${fieldId} must be a date-time`);
  }
}

/** Validate accepted content against the request schema before it reaches the agent. */
export function validateElicitationField(
  request: ElicitationRequest,
  fieldId: string,
  value: ElicitationContentValue,
): void {
  const schema = request.requestedSchema as Record<string, unknown>;
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const field = properties[fieldId];
  if (!field) throw new ElicitationValidationError(`Unknown field ${fieldId}`);
  if (field.type === "string") {
    if (field.pattern !== undefined) {
      throw new ElicitationValidationError(`String patterns are not supported for ${fieldId}`);
    }
    assertBoundedText(value, fieldId);
    if (typeof field.minLength === "number" && value.length < field.minLength) throw new ElicitationValidationError(`${fieldId} is too short`);
    if (typeof field.maxLength === "number" && value.length > field.maxLength) throw new ElicitationValidationError(`${fieldId} is too long`);
    const values = enumValues(field);
    if (values && !values.includes(value)) throw new ElicitationValidationError(`${fieldId} is not an allowed option`);
    validateStringFormat(value, field.format, fieldId);
  } else if (field.type === "number" || field.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) {
      throw new ElicitationValidationError(`${fieldId} must be a ${field.type}`);
    }
    if (typeof field.minimum === "number" && value < field.minimum) throw new ElicitationValidationError(`${fieldId} is below minimum`);
    if (typeof field.maximum === "number" && value > field.maximum) throw new ElicitationValidationError(`${fieldId} is above maximum`);
  } else if (field.type === "boolean") {
    if (typeof value !== "boolean") throw new ElicitationValidationError(`${fieldId} must be a boolean`);
  } else if (field.type === "array") {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
      throw new ElicitationValidationError(`${fieldId} must be a string array`);
    }
    const allowed = multiValues(field);
    if (value.some((entry) => !allowed.includes(entry))) throw new ElicitationValidationError(`${fieldId} contains an invalid option`);
    if (typeof field.minItems === "number" && value.length < field.minItems) throw new ElicitationValidationError(`${fieldId} has too few selections`);
    if (typeof field.maxItems === "number" && value.length > field.maxItems) throw new ElicitationValidationError(`${fieldId} has too many selections`);
  }
}

/** Validate accepted content against the request schema before it reaches the agent. */
export function validateElicitationContent(
  request: ElicitationRequest,
  content: Record<string, ElicitationContentValue>,
): void {
  if (Buffer.byteLength(JSON.stringify(content), "utf8") > MAX_RESPONSE_BYTES) {
    throw new ElicitationValidationError("Form response is too large");
  }
  const schema = request.requestedSchema as Record<string, unknown>;
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  for (const fieldId of required) {
    if (!(fieldId in content)) throw new ElicitationValidationError(`${fieldId} is required`);
  }
  for (const [fieldId, value] of Object.entries(content)) {
    validateElicitationField(request, fieldId, value);
  }
}

/** Core-owned transient state machine for ACP form elicitation. */
export class ElicitationGate {
  private readonly pending = new Map<string, PendingEntry>();
  private readonly settled = new Map<string, number>();

  constructor(
    private readonly onResolved?: (event: ElicitationResolvedEvent) => void,
    private readonly defaultTimeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly maxPending = MAX_PENDING,
  ) {}

  get size(): number { return this.pending.size; }

  get requests(): ElicitationRequest[] {
    return [...this.pending.values()].map(({ request }) => structuredClone(request));
  }

  get(requestId: string): ElicitationRequest | undefined {
    const request = this.pending.get(requestId)?.request;
    return request ? structuredClone(request) : undefined;
  }

  request(
    request: Omit<ElicitationRequest, "expiresAt"> & { timeoutMs?: number },
  ): Promise<ElicitationResponse> {
    validateElicitationRequest({ ...request, expiresAt: Date.now() } as ElicitationRequest);
    if (this.pending.size >= this.maxPending) throw new Error("Too many pending input requests");
    if (this.pending.has(request.id) || this.settled.has(request.id)) throw new Error("Duplicate input request ID");
    const timeoutMs = Math.max(1, Math.min(request.timeoutMs ?? this.defaultTimeoutMs, MAX_TIMEOUT_MS));
    const stored: ElicitationRequest = {
      ...request,
      expiresAt: Date.now() + timeoutMs,
    };
    delete (stored as ElicitationRequest & { timeoutMs?: number }).timeoutMs;
    return new Promise<ElicitationResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.settle(stored.id, { action: "cancel" }, "timeout");
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(stored.id, { request: stored, resolve, timer });
    });
  }

  resolve(requestId: string, response: ElicitationResponse, resolvedBy?: string): ElicitationResolveResult {
    const entry = this.pending.get(requestId);
    if (!entry) return this.settled.has(requestId) ? "already_resolved" : "not_found";
    if (response.action === "accept") validateElicitationContent(entry.request, response.content);
    this.settle(requestId, response, "user", resolvedBy);
    return "resolved";
  }

  cancel(
    requestId: string,
    reason: Exclude<ElicitationResolvedEvent["reason"], "user" | "timeout"> = "cancelled",
  ): ElicitationResolveResult {
    if (!this.pending.has(requestId)) return this.settled.has(requestId) ? "already_resolved" : "not_found";
    this.settle(requestId, { action: "cancel" }, reason);
    return "resolved";
  }

  cancelTurn(turnId: string, reason: Exclude<ElicitationResolvedEvent["reason"], "user" | "timeout"> = "cancelled"): void {
    for (const entry of [...this.pending.values()]) {
      if (entry.request.turnId === turnId) this.settle(entry.request.id, { action: "cancel" }, reason);
    }
  }

  cancelAll(reason: Exclude<ElicitationResolvedEvent["reason"], "user" | "timeout"> = "cancelled"): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, { action: "cancel" }, reason);
  }

  private settle(
    requestId: string,
    response: ElicitationResponse,
    reason: ElicitationResolvedEvent["reason"],
    resolvedBy?: string,
  ): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(requestId);
    this.settled.set(requestId, Date.now());
    while (this.settled.size > MAX_SETTLED) this.settled.delete(this.settled.keys().next().value!);
    entry.resolve(response);
    this.onResolved?.({
      sessionId: entry.request.sessionId,
      requestId,
      action: response.action,
      reason,
      resolvedBy,
    });
  }
}
