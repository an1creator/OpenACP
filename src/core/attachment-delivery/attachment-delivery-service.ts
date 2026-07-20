import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { IChannelAdapter } from "../channel.js";
import type { FileServiceInterface } from "../plugin/types.js";
import type { Session, SessionAttachmentLease } from "../sessions/session.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type {
  AttachmentDeliveryReceipt,
  AttachmentDeliveryRequest,
  AttachmentDeliveryTarget,
  AttachmentTargetBinding,
} from "../types.js";
import { createChildLogger } from "../utils/log.js";
import { AttachmentDeliveryJournal } from "./delivery-journal.js";
import { AttachmentDeliveryError, asAttachmentDeliveryError } from "./errors.js";

const log = createChildLogger({ module: "attachment-delivery" });
const DELIVERY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MIME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/;
const DEFAULT_MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000;
const DEFAULT_TARGET_TTL_MS = 5 * 60_000;
const MAX_CLOCK_SKEW_MS = 30_000;

/** Input used to resolve a caller to one exact live OpenACP target. */
export interface AttachmentTargetResolveRequest {
  /** Exact OpenACP session selected by an operator-aware caller. */
  explicitSessionId?: string;
  /** Exact ACP agent-session identity required for non-explicit routing. */
  agentSessionId?: string;
  /** Optional workspace guard applied to the selected session. */
  expectedWorkingDirectory?: string;
  /** Permit a zero-match agent lookup to use the canonical default Assistant. */
  allowDefaultAssistantFallback?: boolean;
}

/** Auditable reason that a resolved attachment target was selected. */
export type AttachmentTargetRouteKind = "explicit_session" | "agent_session" | "default_assistant";

/** Successful or nonfatal-unavailable target resolution. */
export type AttachmentTargetResolution =
  | { status: "resolved"; routeKind: AttachmentTargetRouteKind; target: AttachmentDeliveryTarget }
  | {
      status: "target_unavailable";
      code: "assistant_not_found";
      retryable: false;
      safeMessage: "No active OpenACP target is available.";
    };

/** Validated delivery metadata plus the bounded uploaded file body. */
export interface AttachmentDeliveryInput {
  schemaVersion: 1;
  deliveryId: string;
  target: AttachmentDeliveryTarget;
  fileName: string;
  mimeType: string;
  size: number;
  sha256: string;
  caption?: string;
  data: Buffer;
  signal?: AbortSignal;
}

/** Adapter support reported by the attachment-delivery health probe. */
export interface AttachmentDeliveryAdapterHealth {
  adapterId: string;
  available: boolean;
  fileUpload: boolean;
  acknowledgedReceipt: boolean;
}

/** Side-effect-free health information for the attachment-delivery protocol. */
export interface AttachmentDeliveryServiceHealth {
  status: "ok" | "degraded";
  protocolVersion: 1;
  fileServiceAvailable: true;
  maxFileSizeBytes: number;
  deliveryTimeoutMs: number;
  adapters: AttachmentDeliveryAdapterHealth[];
}

/** Host dependencies required by AttachmentDeliveryService. */
export interface AttachmentDeliveryServiceDependencies {
  sessionManager: SessionManager;
  adapters: ReadonlyMap<string, IChannelAdapter>;
  fileService: Pick<FileServiceInterface, "saveFile">;
  journalPath: string;
  /** Resolves the host's canonical default Assistant without scanning sessions. */
  resolveDefaultAssistant?: () => Session | null;
  /** Test seam or host-specific staging cleanup implementation. */
  removeStagedFile?: (filePath: string) => Promise<void>;
}

/** Bounded runtime policy for AttachmentDeliveryService. */
export interface AttachmentDeliveryServiceOptions {
  maxFileSizeBytes?: number;
  deliveryTimeoutMs?: number;
  targetTtlMs?: number;
  /** Deterministic test seam; production callers should omit this process secret. */
  targetSecret?: Buffer;
  now?: () => number;
}

interface CapturedTarget {
  session: Session;
  adapter: IChannelAdapter;
  lease: SessionAttachmentLease;
  agentSessionId: string;
  agentGeneration: number;
  requiresDefaultAssistantCurrentness: boolean;
}

function deliveryLockKey(target: AttachmentDeliveryTarget, deliveryId: string): string {
  return `${target.sessionId.length}:${target.sessionId}${target.adapterId.length}:${target.adapterId}${deliveryId}`;
}

function unavailableResolution(): AttachmentTargetResolution {
  return {
    status: "target_unavailable",
    code: "assistant_not_found",
    retryable: false,
    safeMessage: "No active OpenACP target is available.",
  };
}

/**
 * Resolves, stages, and delivers local attachments with provider receipts.
 *
 * Mutable routing state is captured as an opaque target, then checked again
 * after staging and by the adapter immediately before its provider call.
 */
export class AttachmentDeliveryService {
  private readonly journal: AttachmentDeliveryJournal;
  private readonly maxFileSizeBytes: number;
  private readonly deliveryTimeoutMs: number;
  private readonly targetTtlMs: number;
  private readonly targetSecret: Buffer;
  private readonly now: () => number;
  private readonly removeStagedFile: (filePath: string) => Promise<void>;
  // Weak keys bind proofs to runtime identity without retaining retired objects.
  private readonly sessionObjectNonces = new WeakMap<object, string>();
  private readonly adapterObjectNonces = new WeakMap<object, string>();
  private readonly deliveryTails = new Map<string, Promise<void>>();
  private readonly activeControllers = new Set<AbortController>();
  private closing = false;
  private closeOperation: Promise<void> | null = null;

  constructor(
    private readonly deps: AttachmentDeliveryServiceDependencies,
    options: AttachmentDeliveryServiceOptions = {},
  ) {
    this.maxFileSizeBytes = this.positiveInteger(
      options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES,
      "maxFileSizeBytes",
    );
    this.deliveryTimeoutMs = this.positiveInteger(
      options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS,
      "deliveryTimeoutMs",
    );
    this.targetTtlMs = this.positiveInteger(
      options.targetTtlMs ?? DEFAULT_TARGET_TTL_MS,
      "targetTtlMs",
    );
    this.targetSecret = options.targetSecret ?? randomBytes(32);
    if (!Buffer.isBuffer(this.targetSecret) || this.targetSecret.length < 32) {
      throw new AttachmentDeliveryError("internal_error", {
        safeMessage: "Attachment target signing is not configured safely.",
      });
    }
    this.now = options.now ?? Date.now;
    this.removeStagedFile = deps.removeStagedFile ?? ((filePath) => fs.unlink(filePath));
    this.journal = new AttachmentDeliveryJournal(deps.journalPath);
  }

  /** Resolve an explicit, exact agent, or opt-in canonical Assistant target. */
  async resolveTarget(request: AttachmentTargetResolveRequest): Promise<AttachmentTargetResolution> {
    this.assertOpen();
    this.validateResolveRequest(request);

    let session: Session | undefined;
    let routeKind: AttachmentTargetRouteKind;
    if (request.explicitSessionId) {
      session = this.deps.sessionManager.getSession(request.explicitSessionId);
      if (!session || !this.isDeliverableSession(session)) {
        throw new AttachmentDeliveryError("target_stale");
      }
      if (request.agentSessionId && session.agentSessionId !== request.agentSessionId) {
        throw new AttachmentDeliveryError("target_mismatch");
      }
      routeKind = "explicit_session";
    } else {
      const candidates = this.deps.sessionManager
        .getCurrentLiveSessionsByAgentSessionId(request.agentSessionId!)
        .filter((candidate) => this.isDeliverableSession(candidate));
      if (candidates.length > 1) return unavailableResolution();
      if (candidates.length === 1) {
        [session] = candidates;
        routeKind = "agent_session";
      } else {
        if (request.allowDefaultAssistantFallback !== true) return unavailableResolution();
        const defaultAssistant = this.deps.resolveDefaultAssistant?.();
        if (!defaultAssistant?.isAssistant || !this.isDeliverableSession(defaultAssistant)) {
          return unavailableResolution();
        }
        session = defaultAssistant;
        routeKind = "default_assistant";
      }
    }

    if (
      request.expectedWorkingDirectory
      && path.resolve(request.expectedWorkingDirectory) !== path.resolve(session.workingDirectory)
    ) {
      throw new AttachmentDeliveryError("target_mismatch");
    }

    let captured: CapturedTarget;
    try {
      captured = this.captureCurrentTarget(session, routeKind === "default_assistant");
    } catch (error) {
      if (!request.explicitSessionId && error instanceof AttachmentDeliveryError && error.code === "target_stale") {
        return unavailableResolution();
      }
      throw error;
    }
    const issuedAt = this.now();
    return {
      status: "resolved",
      routeKind,
      target: Object.freeze({
        schemaVersion: 1,
        sessionId: session.id,
        adapterId: captured.adapter.name,
        bindingGeneration: this.signBinding(captured, issuedAt),
      }),
    };
  }

  /** Deliver one validated upload or return its previously committed receipt. */
  async deliver(input: AttachmentDeliveryInput): Promise<AttachmentDeliveryReceipt> {
    this.assertOpen();
    this.validateDeliveryInput(input);
    const target: AttachmentDeliveryTarget = Object.freeze({
      schemaVersion: 1,
      sessionId: input.target.sessionId,
      adapterId: input.target.adapterId,
      bindingGeneration: input.target.bindingGeneration,
    });
    const actualSha256 = createHash("sha256").update(input.data).digest("hex");
    if (!timingSafeEqual(Buffer.from(actualSha256, "hex"), Buffer.from(input.sha256, "hex"))) {
      throw new AttachmentDeliveryError("hash_mismatch");
    }

    const key = deliveryLockKey(target, input.deliveryId);
    return this.withDeliveryLock(key, async () => {
      this.assertOpen();
      if (input.signal?.aborted) throw new AttachmentDeliveryError("provider_timeout");

      const lookup = this.journal.lookup(target, input.deliveryId, input.sha256);
      if (lookup.status === "found") return lookup.receipt;
      if (lookup.status === "conflict") throw new AttachmentDeliveryError("delivery_id_conflict");

      const captured = this.captureAndVerifyTarget(target);
      let stagedPath: string | undefined;
      try {
        const staged = await this.deps.fileService.saveFile(
          captured.session.id,
          input.fileName,
          input.data,
          input.mimeType,
        );
        stagedPath = staged.filePath;
        if (staged.size !== input.size || staged.fileName !== input.fileName || staged.mimeType !== input.mimeType) {
          throw new AttachmentDeliveryError("file_invalid");
        }
        if (!this.isCapturedTargetCurrent(captured, target)) {
          throw new AttachmentDeliveryError("target_stale");
        }

        const binding: AttachmentTargetBinding = Object.freeze({
          target,
          threadId: captured.lease.threadId,
          isCurrent: () => this.isCapturedTargetCurrent(captured, target),
        });
        const receipt = await this.invokeAdapter(captured.adapter, {
          deliveryId: input.deliveryId,
          sessionId: captured.session.id,
          targetBinding: binding,
          attachment: {
            filePath: staged.filePath,
            fileName: input.fileName,
            mimeType: input.mimeType,
            size: input.size,
            sha256: input.sha256,
          },
          caption: input.caption,
          signal: input.signal ?? new AbortController().signal,
        });
        this.validateReceipt(receipt, input.deliveryId, captured.adapter.name);
        await this.journal.commit(target, input.sha256, receipt);
        return receipt;
      } catch (error) {
        throw asAttachmentDeliveryError(error);
      } finally {
        if (stagedPath) {
          try {
            await this.removeStagedFile(stagedPath);
          } catch (error) {
            log.warn({ err: error, sessionId: target.sessionId }, "Failed to clean up staged attachment");
          }
        }
      }
    });
  }

  /** Return side-effect-free protocol, limit, and adapter support information. */
  getHealth(): AttachmentDeliveryServiceHealth {
    const adapters = [...this.deps.adapters.entries()].map(([adapterId, adapter]) => ({
      adapterId,
      available: !this.closing && this.isAdapterOperational(adapter),
      fileUpload: adapter.capabilities.fileUpload,
      acknowledgedReceipt: typeof adapter.deliverAttachment === "function",
    }));
    const supported = adapters.some((adapter) => adapter.available && adapter.fileUpload && adapter.acknowledgedReceipt);
    return {
      status: supported ? "ok" : "degraded",
      protocolVersion: 1,
      fileServiceAvailable: true,
      maxFileSizeBytes: this.maxFileSizeBytes,
      deliveryTimeoutMs: this.deliveryTimeoutMs,
      adapters,
    };
  }

  /** Return the route-facing health shape without performing provider I/O. */
  async health(): Promise<{
    status: "ok" | "unavailable";
    protocolVersion: 1;
    serviceLoaded: true;
    fileServiceAvailable: true;
    maxFileSize: number;
    adapters: AttachmentDeliveryAdapterHealth[];
  }> {
    const health = this.getHealth();
    return {
      status: health.status === "ok" ? "ok" : "unavailable",
      protocolVersion: 1,
      serviceLoaded: true,
      fileServiceAvailable: true,
      maxFileSize: health.maxFileSizeBytes,
      adapters: health.adapters,
    };
  }

  /** Abort active work, reject queued work, and drain the durable journal once. */
  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.closing = true;
    for (const controller of this.activeControllers) {
      controller.abort(new AttachmentDeliveryError("provider_unavailable", {
        safeMessage: "Attachment delivery is shutting down.",
      }));
    }
    const operations = [...this.deliveryTails.values()];
    this.closeOperation = Promise.allSettled(operations)
      .then(() => this.journal.close());
    return this.closeOperation;
  }

  private captureCurrentTarget(
    session: Session,
    requiresDefaultAssistantCurrentness = false,
  ): CapturedTarget {
    if (!this.isDeliverableSession(session)) throw new AttachmentDeliveryError("target_stale");
    if (requiresDefaultAssistantCurrentness && !this.isCanonicalDefaultAssistant(session)) {
      throw new AttachmentDeliveryError("target_stale");
    }
    const adapterId = session.channelId;
    const adapter = this.deps.adapters.get(adapterId);
    if (!adapter || !adapter.capabilities.fileUpload || typeof adapter.deliverAttachment !== "function") {
      throw new AttachmentDeliveryError("unsupported_channel");
    }
    if (!this.isAdapterOperational(adapter)) {
      throw new AttachmentDeliveryError("provider_unavailable");
    }
    const threadId = session.threadIds.get(adapterId) ?? (session.channelId === adapterId ? session.threadId : "");
    if (!threadId) throw new AttachmentDeliveryError("target_stale");
    const lease = session.captureAttachmentLease(adapterId, threadId);
    if (!lease) throw new AttachmentDeliveryError("target_stale");
    return {
      session,
      adapter,
      lease,
      agentSessionId: session.agentSessionId,
      agentGeneration: session.agentGeneration,
      requiresDefaultAssistantCurrentness,
    };
  }

  private captureAndVerifyTarget(target: AttachmentDeliveryTarget): CapturedTarget {
    const session = this.deps.sessionManager.getSession(target.sessionId);
    if (!session || !this.isDeliverableSession(session) || session.channelId !== target.adapterId) {
      throw new AttachmentDeliveryError("target_stale");
    }
    const captured = this.captureCurrentTarget(session);
    const issuedAt = this.parseBindingTimestamp(target.bindingGeneration);
    const age = this.now() - issuedAt;
    if (age < -MAX_CLOCK_SKEW_MS || age > this.targetTtlMs) {
      throw new AttachmentDeliveryError("target_stale");
    }
    if (this.safeTokenEqual(this.signBinding(captured, issuedAt), target.bindingGeneration)) {
      return captured;
    }
    if (this.isCanonicalDefaultAssistant(session)) {
      const defaultAssistantCapture: CapturedTarget = {
        ...captured,
        requiresDefaultAssistantCurrentness: true,
      };
      if (this.safeTokenEqual(this.signBinding(defaultAssistantCapture, issuedAt), target.bindingGeneration)) {
        return defaultAssistantCapture;
      }
    }
    throw new AttachmentDeliveryError("target_stale");
  }

  private isCapturedTargetCurrent(captured: CapturedTarget, target: AttachmentDeliveryTarget): boolean {
    return !this.closing
      && this.deps.sessionManager.getSession(captured.session.id) === captured.session
      && this.isDeliverableSession(captured.session)
      && captured.session.agentSessionId === captured.agentSessionId
      && captured.session.agentGeneration === captured.agentGeneration
      && (!captured.requiresDefaultAssistantCurrentness || this.isCanonicalDefaultAssistant(captured.session))
      && captured.session.channelId === target.adapterId
      && captured.session.isAttachmentLeaseCurrent(captured.lease)
      && this.deps.adapters.get(target.adapterId) === captured.adapter
      && this.isAdapterOperational(captured.adapter)
      && captured.adapter.capabilities.fileUpload
      && typeof captured.adapter.deliverAttachment === "function";
  }

  private isAdapterOperational(adapter: IChannelAdapter): boolean {
    return adapter.isOperational?.() ?? true;
  }

  private isCanonicalDefaultAssistant(session: Session): boolean {
    return session.isAssistant === true && this.deps.resolveDefaultAssistant?.() === session;
  }

  private isDeliverableSession(session: Session): boolean {
    return this.deps.sessionManager.isCurrentLiveSession(session)
      && !session.isTerminating
      && !session.archiving
      && session.status !== "finished"
      && session.status !== "cancelled";
  }

  private signBinding(captured: CapturedTarget, issuedAt: number): string {
    const timestamp = issuedAt.toString(36);
    const payload = JSON.stringify([
      timestamp,
      captured.session.id,
      captured.adapter.name,
      captured.lease.threadId,
      captured.lease.generation,
      captured.agentSessionId,
      captured.agentGeneration,
      captured.requiresDefaultAssistantCurrentness,
      this.getObjectNonce(this.sessionObjectNonces, captured.session),
      this.getObjectNonce(this.adapterObjectNonces, captured.adapter),
    ]);
    const mac = createHmac("sha256", this.targetSecret).update(payload).digest("base64url");
    return `${timestamp}.${mac}`;
  }

  private parseBindingTimestamp(bindingGeneration: string): number {
    const match = /^([0-9a-z]{1,16})\.([A-Za-z0-9_-]{43})$/.exec(bindingGeneration);
    if (!match) throw new AttachmentDeliveryError("target_stale");
    const issuedAt = Number.parseInt(match[1], 36);
    if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) throw new AttachmentDeliveryError("target_stale");
    return issuedAt;
  }

  private safeTokenEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }

  private getObjectNonce(nonces: WeakMap<object, string>, value: object): string {
    const existing = nonces.get(value);
    if (existing) return existing;
    const nonce = randomBytes(16).toString("base64url");
    nonces.set(value, nonce);
    return nonce;
  }

  private async invokeAdapter(
    adapter: IChannelAdapter,
    request: AttachmentDeliveryRequest,
  ): Promise<AttachmentDeliveryReceipt> {
    if (!request.targetBinding.isCurrent()) throw new AttachmentDeliveryError("target_stale");
    const deliver = adapter.deliverAttachment;
    if (!deliver) throw new AttachmentDeliveryError("unsupported_channel");

    const controller = new AbortController();
    this.activeControllers.add(controller);
    const externalAbort = () => controller.abort(new AttachmentDeliveryError("provider_timeout"));
    request.signal.addEventListener("abort", externalAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new AttachmentDeliveryError("provider_timeout")),
      this.deliveryTimeoutMs,
    );
    timer.unref?.();
    const abortPromise = new Promise<never>((_, reject) => {
      if (controller.signal.aborted) {
        reject(controller.signal.reason);
        return;
      }
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
    });
    const providerRequest: AttachmentDeliveryRequest = { ...request, signal: controller.signal };
    const providerOperation = Promise.resolve().then(() => deliver.call(adapter, providerRequest));
    // An adapter may ignore cancellation and settle after the timeout race. Keep
    // observing that promise so a late rejection cannot become unhandled.
    void providerOperation.catch(() => undefined);
    try {
      return await Promise.race([providerOperation, abortPromise]);
    } catch (error) {
      if (controller.signal.aborted) throw new AttachmentDeliveryError("provider_timeout", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
      request.signal.removeEventListener("abort", externalAbort);
      this.activeControllers.delete(controller);
    }
  }

  private validateResolveRequest(request: AttachmentTargetResolveRequest): void {
    if (!request || typeof request !== "object") throw new AttachmentDeliveryError("target_mismatch");
    if (request.explicitSessionId !== undefined && !this.validBoundedString(request.explicitSessionId, 200)) {
      throw new AttachmentDeliveryError("target_mismatch");
    }
    if (request.agentSessionId !== undefined && !this.validBoundedString(request.agentSessionId, 300)) {
      throw new AttachmentDeliveryError("target_mismatch");
    }
    if (
      request.allowDefaultAssistantFallback !== undefined
      && typeof request.allowDefaultAssistantFallback !== "boolean"
    ) {
      throw new AttachmentDeliveryError("target_mismatch");
    }
    if (!request.explicitSessionId && !request.agentSessionId) {
      throw new AttachmentDeliveryError("target_mismatch");
    }
    if (
      request.expectedWorkingDirectory !== undefined
      && !this.validBoundedString(request.expectedWorkingDirectory, 4_096)
    ) {
      throw new AttachmentDeliveryError("target_mismatch");
    }
  }

  private validateDeliveryInput(input: AttachmentDeliveryInput): void {
    if (!input || typeof input !== "object" || input.schemaVersion !== 1) {
      throw new AttachmentDeliveryError("file_invalid");
    }
    if (!DELIVERY_ID_PATTERN.test(input.deliveryId)) throw new AttachmentDeliveryError("file_invalid");
    this.validateTarget(input.target);
    if (!this.validBoundedString(input.fileName, 255)
      || input.fileName !== path.basename(input.fileName)
      || /[\\/\0]/.test(input.fileName)) {
      throw new AttachmentDeliveryError("file_invalid");
    }
    if (!this.validBoundedString(input.mimeType, 200) || !MIME_PATTERN.test(input.mimeType)) {
      throw new AttachmentDeliveryError("file_invalid");
    }
    if (!Number.isSafeInteger(input.size) || input.size < 0) throw new AttachmentDeliveryError("file_invalid");
    if (input.size > this.maxFileSizeBytes) throw new AttachmentDeliveryError("payload_too_large");
    if (!Buffer.isBuffer(input.data) || input.data.length !== input.size) {
      throw new AttachmentDeliveryError("file_invalid");
    }
    if (!SHA256_PATTERN.test(input.sha256)) throw new AttachmentDeliveryError("file_invalid");
    if (input.caption !== undefined && (typeof input.caption !== "string" || input.caption.length > 1_024)) {
      throw new AttachmentDeliveryError("file_invalid");
    }
  }

  private validateTarget(target: AttachmentDeliveryTarget): void {
    if (!target || typeof target !== "object" || target.schemaVersion !== 1
      || !this.validBoundedString(target.sessionId, 200)
      || !this.validBoundedString(target.adapterId, 100)
      || !this.validBoundedString(target.bindingGeneration, 128)) {
      throw new AttachmentDeliveryError("target_stale");
    }
  }

  private validateReceipt(receipt: AttachmentDeliveryReceipt, deliveryId: string, adapterId: string): void {
    if (!receipt || receipt.status !== "provider_accepted"
      || receipt.deliveryId !== deliveryId
      || receipt.adapterId !== adapterId
      || !this.validBoundedString(receipt.providerMessageId, 300)
      || !this.validBoundedString(receipt.acceptedAt, 100)
      || Number.isNaN(Date.parse(receipt.acceptedAt))) {
      throw new AttachmentDeliveryError("internal_error", {
        safeMessage: "The attachment provider returned an invalid acknowledgement.",
      });
    }
  }

  private async withDeliveryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.deliveryTails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.deliveryTails.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.deliveryTails.get(key) === tail) this.deliveryTails.delete(key);
    }
  }

  private validBoundedString(value: unknown, maxLength: number): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= maxLength;
  }

  private positiveInteger(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AttachmentDeliveryError("internal_error", {
        safeMessage: `Attachment delivery ${name} is invalid.`,
      });
    }
    return value;
  }

  private assertOpen(): void {
    if (this.closing) {
      throw new AttachmentDeliveryError("provider_unavailable", {
        safeMessage: "Attachment delivery is shutting down.",
      });
    }
  }
}
