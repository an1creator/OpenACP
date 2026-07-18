import type { FastifyRequest } from 'fastify';
import type { MessageDispatchOutcome } from '../../../core/core.js';
import type { MessagePrincipal } from '../../../core/types.js';
import { AuthError, RateLimitError } from '../middleware/error-handler.js';

type AcceptedPrompt = Extract<MessageDispatchOutcome, { status: 'accepted' }>;

/** Translate Fastify authentication into the transport-neutral core principal. */
export function apiMessagePrincipal(request: FastifyRequest): MessagePrincipal {
  if (request.auth.type === 'secret') {
    return { type: 'api', credential: 'secret' };
  }
  return {
    type: 'api',
    credential: 'jwt',
    tokenId: request.auth.tokenId!,
    linkedUserId: request.auth.userId,
  };
}

/** Map a core ingress decision to the stable HTTP error contract. */
export function requireAcceptedPrompt(outcome: MessageDispatchOutcome): AcceptedPrompt {
  if (outcome.status === 'accepted') return outcome;
  if (outcome.code === 'SESSION_LIMIT') {
    throw new RateLimitError(outcome.code, outcome.reason);
  }
  throw new AuthError(outcome.code, outcome.reason, 403);
}

/** Stable API platform ID: JWTs use their setup-linked identity, master secret has none. */
export function apiPlatformUserId(request: FastifyRequest): string {
  return request.auth.type === 'jwt' ? request.auth.tokenId! : 'api-master';
}
