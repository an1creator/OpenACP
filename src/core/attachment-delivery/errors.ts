/** Stable error codes returned by the acknowledged attachment-delivery boundary. */
export type AttachmentDeliveryErrorCode =
  | "target_unavailable"
  | "target_stale"
  | "target_mismatch"
  | "unsupported_channel"
  | "file_invalid"
  | "hash_mismatch"
  | "payload_too_large"
  | "delivery_id_conflict"
  | "provider_unavailable"
  | "provider_timeout"
  | "provider_rejected"
  | "rate_limited"
  | "internal_error";

interface AttachmentDeliveryErrorDefaults {
  httpStatus: number;
  retryable: boolean;
  safeMessage: string;
}

const ERROR_DEFAULTS: Record<AttachmentDeliveryErrorCode, AttachmentDeliveryErrorDefaults> = {
  target_unavailable: { httpStatus: 404, retryable: false, safeMessage: "No active OpenACP target is available." },
  target_stale: { httpStatus: 409, retryable: false, safeMessage: "The OpenACP target is no longer current." },
  target_mismatch: { httpStatus: 409, retryable: false, safeMessage: "The OpenACP target does not match the calling session." },
  unsupported_channel: { httpStatus: 422, retryable: false, safeMessage: "The target channel does not support acknowledged attachments." },
  file_invalid: { httpStatus: 400, retryable: false, safeMessage: "The attachment metadata or content is invalid." },
  hash_mismatch: { httpStatus: 400, retryable: false, safeMessage: "The attachment checksum does not match its content." },
  payload_too_large: { httpStatus: 413, retryable: false, safeMessage: "The attachment exceeds the configured size limit." },
  delivery_id_conflict: { httpStatus: 409, retryable: false, safeMessage: "The delivery ID was already used for different content or a different target." },
  provider_unavailable: { httpStatus: 503, retryable: true, safeMessage: "The attachment provider is unavailable." },
  provider_timeout: { httpStatus: 504, retryable: true, safeMessage: "The attachment provider timed out." },
  provider_rejected: { httpStatus: 502, retryable: false, safeMessage: "The attachment provider rejected the file." },
  rate_limited: { httpStatus: 429, retryable: true, safeMessage: "The attachment provider rate limit was reached." },
  internal_error: { httpStatus: 500, retryable: true, safeMessage: "Attachment delivery failed internally." },
};

/** Optional safe overrides for a typed attachment-delivery failure. */
export interface AttachmentDeliveryErrorOptions {
  retryable?: boolean;
  safeMessage?: string;
  httpStatus?: number;
  cause?: unknown;
}

/** Error safe to translate into the public attachment-delivery envelope. */
export class AttachmentDeliveryError extends Error {
  readonly code: AttachmentDeliveryErrorCode;
  readonly retryable: boolean;
  readonly safeMessage: string;
  readonly httpStatus: number;

  constructor(code: AttachmentDeliveryErrorCode, options: AttachmentDeliveryErrorOptions = {}) {
    const defaults = ERROR_DEFAULTS[code];
    const safeMessage = options.safeMessage ?? defaults.safeMessage;
    super(safeMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AttachmentDeliveryError";
    this.code = code;
    this.retryable = options.retryable ?? defaults.retryable;
    this.safeMessage = safeMessage;
    this.httpStatus = options.httpStatus ?? defaults.httpStatus;
  }
}

/** Preserve typed failures and hide all untrusted internal error details. */
export function asAttachmentDeliveryError(error: unknown): AttachmentDeliveryError {
  return error instanceof AttachmentDeliveryError
    ? error
    : new AttachmentDeliveryError("internal_error", { cause: error });
}
