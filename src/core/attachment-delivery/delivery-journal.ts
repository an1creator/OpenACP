import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AttachmentDeliveryReceipt, AttachmentDeliveryTarget } from "../types.js";
import { AttachmentDeliveryError } from "./errors.js";

interface StoredDeliveryReceipt {
  sessionId: string;
  adapterId: string;
  bindingGeneration: string;
  deliveryId: string;
  sha256: string;
  receipt: AttachmentDeliveryReceipt;
}

interface DeliveryJournalFile {
  version: 1;
  entries: StoredDeliveryReceipt[];
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isReceipt(value: unknown): value is AttachmentDeliveryReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Record<string, unknown>;
  return hasExactKeys(receipt, ["status", "deliveryId", "providerMessageId", "adapterId", "acceptedAt"])
    && receipt.status === "provider_accepted"
    && typeof receipt.deliveryId === "string"
    && typeof receipt.providerMessageId === "string"
    && receipt.providerMessageId.length > 0
    && typeof receipt.adapterId === "string"
    && typeof receipt.acceptedAt === "string"
    && !Number.isNaN(Date.parse(receipt.acceptedAt));
}

function isStoredEntry(value: unknown): value is StoredDeliveryReceipt {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return hasExactKeys(entry, [
    "sessionId",
    "adapterId",
    "bindingGeneration",
    "deliveryId",
    "sha256",
    "receipt",
  ])
    && typeof entry.sessionId === "string"
    && entry.sessionId.length > 0
    && typeof entry.adapterId === "string"
    && entry.adapterId.length > 0
    && typeof entry.bindingGeneration === "string"
    && entry.bindingGeneration.length > 0
    && typeof entry.deliveryId === "string"
    && entry.deliveryId.length > 0
    && typeof entry.sha256 === "string"
    && SHA256_PATTERN.test(entry.sha256)
    && isReceipt(entry.receipt)
    && entry.receipt.deliveryId === entry.deliveryId
    && entry.receipt.adapterId === entry.adapterId;
}

function journalKey(sessionId: string, adapterId: string, deliveryId: string): string {
  return `${sessionId.length}:${sessionId}${adapterId.length}:${adapterId}${deliveryId}`;
}

/** Durable lookup result for one delivery identity. */
export type DeliveryJournalLookup =
  | { status: "missing" }
  | { status: "found"; receipt: AttachmentDeliveryReceipt }
  | { status: "conflict" };

/**
 * Crash-consistent receipt journal for provider-accepted attachment deliveries.
 *
 * A receipt is published in memory only after a temporary file is fsynced and
 * atomically renamed. Telegram has no provider idempotency key, so a process
 * crash after provider acceptance but before this commit remains irreducibly
 * ambiguous; completed commits are exactly-once across ordinary retries/restarts.
 */
export class AttachmentDeliveryJournal {
  private entries = new Map<string, StoredDeliveryReceipt>();
  private writeTail: Promise<void> = Promise.resolve();
  private closeOperation: Promise<void> | null = null;
  private closing = false;

  constructor(readonly filePath: string) {
    this.load();
  }

  /** Look up a receipt or conflict without mutating durable state. */
  lookup(
    target: Readonly<AttachmentDeliveryTarget>,
    deliveryId: string,
    sha256: string,
  ): DeliveryJournalLookup {
    const entry = this.entries.get(journalKey(target.sessionId, target.adapterId, deliveryId));
    if (!entry) return { status: "missing" };
    if (entry.sha256 !== sha256 || entry.bindingGeneration !== target.bindingGeneration) {
      return { status: "conflict" };
    }
    return { status: "found", receipt: structuredClone(entry.receipt) };
  }

  /** Persist a provider receipt before allowing the caller to report success. */
  async commit(
    target: Readonly<AttachmentDeliveryTarget>,
    sha256: string,
    receipt: AttachmentDeliveryReceipt,
  ): Promise<void> {
    if (this.closing) {
      throw new AttachmentDeliveryError("internal_error", {
        safeMessage: "Attachment delivery is shutting down.",
      });
    }
    const key = journalKey(target.sessionId, target.adapterId, receipt.deliveryId);
    const operation = this.writeTail.then(() => {
      const existing = this.entries.get(key);
      if (existing) {
        if (existing.sha256 === sha256 && existing.bindingGeneration === target.bindingGeneration) return;
        throw new AttachmentDeliveryError("delivery_id_conflict");
      }
      const entry: StoredDeliveryReceipt = {
        sessionId: target.sessionId,
        adapterId: target.adapterId,
        bindingGeneration: target.bindingGeneration,
        deliveryId: receipt.deliveryId,
        sha256,
        receipt: structuredClone(receipt),
      };
      const next = new Map(this.entries);
      next.set(key, entry);
      this.atomicWrite([...next.values()]);
      this.entries = next;
    });
    this.writeTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  /** Reject new commits and drain every already accepted journal mutation. */
  close(): Promise<void> {
    if (this.closeOperation) return this.closeOperation;
    this.closing = true;
    this.closeOperation = this.writeTail;
    return this.closeOperation;
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object") throw new Error("journal root must be an object");
      const envelope = parsed as Record<string, unknown>;
      if (envelope.version !== 1 || !Array.isArray(envelope.entries)) {
        throw new Error("unsupported journal version or entries shape");
      }
      const exactRootKeys = hasExactKeys(envelope, ["version", "entries"]);
      if (!exactRootKeys || !envelope.entries.every(isStoredEntry)) {
        throw new Error("journal contains invalid or unknown fields");
      }
      for (const entry of envelope.entries) {
        const key = journalKey(entry.sessionId, entry.adapterId, entry.deliveryId);
        if (this.entries.has(key)) throw new Error("journal contains duplicate delivery identities");
        this.entries.set(key, structuredClone(entry));
      }
      fs.chmodSync(this.filePath, 0o600);
    } catch (error) {
      throw new AttachmentDeliveryError("internal_error", {
        safeMessage: "The attachment receipt journal is invalid.",
        cause: error,
      });
    }
  }

  private atomicWrite(entries: StoredDeliveryReceipt[]): void {
    const directory = path.dirname(this.filePath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    const temporary = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      const envelope: DeliveryJournalFile = { version: 1, entries };
      fs.writeFileSync(descriptor, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      if (process.platform !== "win32") {
        const directoryDescriptor = fs.openSync(directory, "r");
        try {
          fs.fsyncSync(directoryDescriptor);
        } finally {
          fs.closeSync(directoryDescriptor);
        }
      }
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      let cleanupError: unknown;
      try {
        fs.rmSync(temporary, { force: true });
      } catch (failure) {
        cleanupError = failure;
      }
      throw new AttachmentDeliveryError("internal_error", {
        safeMessage: "The attachment receipt could not be persisted.",
        cause: cleanupError === undefined ? error : new AggregateError([error, cleanupError]),
      });
    }
  }
}
