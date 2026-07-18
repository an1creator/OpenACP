import { describe, expect, it, vi } from 'vitest';
import { relayHeadlessElicitationRequest, relayHeadlessElicitationResolved, relayHeadlessSessionEvent } from '../index.js';
import { HEADLESS_DELIVERY_CLAIM } from '../../../core/sessions/session.js';

describe('headless API elicitation relay', () => {
  const request = {
    id: 'input-1',
    sessionId: 'headless-1',
    mode: 'form' as const,
    message: 'Choose',
    requestedSchema: {
      type: 'object' as const,
      properties: { answer: { type: 'string' as const, enum: ['yes', 'no'] } },
      required: ['answer'],
    },
    targetAdapterId: 'sse',
    owner: { adapterId: 'api', apiCredential: 'jwt' as const, apiTokenId: 'owner-token' },
  };

  it('uses the live pending gate without resume or other session creation side effects', async () => {
    const getSession = vi.fn().mockReturnValue({
      id: 'headless-1',
      channelId: 'api',
      elicitationGate: { get: vi.fn().mockReturnValue(request) },
    });
    const core = { sessionManager: { getSession }, getOrResumeSessionById: vi.fn() } as any;
    const adapter = { sendElicitationRequest: vi.fn().mockResolvedValue(undefined) } as any;

    await expect(relayHeadlessElicitationRequest(core, adapter, {
      sessionId: 'headless-1',
      request: { id: 'input-1' },
    })).resolves.toBe(true);

    expect(adapter.sendElicitationRequest).toHaveBeenCalledWith('headless-1', request);
    expect(core.getOrResumeSessionById).not.toHaveBeenCalled();
  });

  it('does not duplicate bridged sessions or prompts whose response routing is suppressed', async () => {
    const bridgedCore = {
      sessionManager: { getSession: vi.fn().mockReturnValue({ channelId: 'telegram' }) },
    } as any;
    const suppressedCore = {
      sessionManager: {
        getSession: vi.fn().mockReturnValue({
          id: 'headless-1',
          channelId: 'api',
          elicitationGate: { get: vi.fn().mockReturnValue({ ...request, targetAdapterId: undefined }) },
        }),
      },
    } as any;
    const adapter = { sendElicitationRequest: vi.fn() } as any;

    await expect(relayHeadlessElicitationRequest(bridgedCore, adapter, {
      sessionId: 'headless-1', request: { id: 'input-1' },
    })).resolves.toBe(false);
    await expect(relayHeadlessElicitationRequest(suppressedCore, adapter, {
      sessionId: 'headless-1', request: { id: 'input-1' },
    })).resolves.toBe(false);
    expect(adapter.sendElicitationRequest).not.toHaveBeenCalled();
  });

  it('delivers safe terminal metadata through the same headless lifecycle', async () => {
    const core = {
      sessionManager: { getSession: vi.fn().mockReturnValue({ id: 'headless-1', channelId: 'api' }) },
    } as any;
    const adapter = { dismissElicitationRequest: vi.fn().mockResolvedValue(undefined) } as any;
    const event = {
      requestId: 'input-1', sessionId: 'headless-1', action: 'decline' as const, resolvedBy: 'token:owner-token',
    };

    await expect(relayHeadlessElicitationResolved(core, adapter, event)).resolves.toBe(true);
    expect(adapter.dismissElicitationRequest).toHaveBeenCalledWith('headless-1', event);
  });

  it('hands request and resolution delivery to an attached SSE bridge without duplicates', async () => {
    const session = {
      id: 'headless-1',
      channelId: 'api',
      attachedAdapters: ['api', 'sse'],
      elicitationGate: { get: vi.fn().mockReturnValue(request) },
    };
    const core = { sessionManager: { getSession: vi.fn().mockReturnValue(session) } } as any;
    const adapter = {
      sendElicitationRequest: vi.fn().mockResolvedValue(undefined),
      dismissElicitationRequest: vi.fn().mockResolvedValue(undefined),
    } as any;
    const event = {
      requestId: 'input-1', sessionId: 'headless-1', action: 'cancel' as const,
    };

    await expect(relayHeadlessElicitationRequest(core, adapter, {
      sessionId: 'headless-1', request: { id: 'input-1' },
    })).resolves.toBe(false);
    await expect(relayHeadlessElicitationResolved(core, adapter, event)).resolves.toBe(false);
    expect(adapter.sendElicitationRequest).not.toHaveBeenCalled();
    expect(adapter.dismissElicitationRequest).not.toHaveBeenCalled();

    session.attachedAdapters = ['api'];
    await expect(relayHeadlessElicitationRequest(core, adapter, {
      sessionId: 'headless-1', request: { id: 'input-1' },
    })).resolves.toBe(true);
    await expect(relayHeadlessElicitationResolved(core, adapter, event)).resolves.toBe(true);
  });

  it('finishes request, resolution, and ordinary events claimed before SSE bridge cutover', async () => {
    const claim = { sessionId: 'headless-1', id: 1, epoch: 0, kind: 'handoff' } as const;
    const session = {
      id: 'headless-1',
      channelId: 'api',
      attachedAdapters: ['api', 'sse'],
      elicitationGate: { get: vi.fn().mockReturnValue(request) },
      isHeadlessDeliveryClaimActive: vi.fn((candidate) => candidate === claim),
    };
    const core = { sessionManager: { getSession: vi.fn().mockReturnValue(session) } } as any;
    const adapter = {
      sendElicitationRequest: vi.fn().mockResolvedValue(undefined),
      dismissElicitationRequest: vi.fn().mockResolvedValue(undefined),
      sendSessionEvent: vi.fn().mockResolvedValue(undefined),
    } as any;
    const requestData = { sessionId: 'headless-1', request: { id: 'input-1' } } as any;
    const resolvedData = { requestId: 'input-1', sessionId: 'headless-1', action: 'cancel' as const } as any;
    const ordinaryData = { sessionId: 'headless-1', event: { type: 'text', content: 'hello' } } as any;
    Object.defineProperty(requestData, HEADLESS_DELIVERY_CLAIM, { value: claim });
    Object.defineProperty(resolvedData, HEADLESS_DELIVERY_CLAIM, { value: claim });
    Object.defineProperty(ordinaryData, HEADLESS_DELIVERY_CLAIM, { value: claim });

    await expect(relayHeadlessElicitationRequest(core, adapter, requestData)).resolves.toBe(true);
    await expect(relayHeadlessElicitationResolved(core, adapter, resolvedData)).resolves.toBe(true);
    await expect(relayHeadlessSessionEvent(core, adapter, 'agent:event', ordinaryData)).resolves.toBe(true);
    expect(adapter.sendElicitationRequest).toHaveBeenCalledOnce();
    expect(adapter.dismissElicitationRequest).toHaveBeenCalledOnce();
    expect(adapter.sendSessionEvent).toHaveBeenCalledOnce();
  });

  it('relays ordinary agent output for a headless session and avoids a real SSE bridge duplicate', async () => {
    const session = { id: 'headless-1', channelId: 'api', attachedAdapters: ['api'] };
    const core = { sessionManager: { getSession: vi.fn().mockReturnValue(session) } } as any;
    const adapter = { sendSessionEvent: vi.fn().mockResolvedValue(undefined) } as any;
    const data = {
      sessionId: 'headless-1', turnId: 'turn-1', event: { type: 'text', text: 'hello' },
    };

    await expect(relayHeadlessSessionEvent(core, adapter, 'agent:event', data)).resolves.toBe(true);
    expect(adapter.sendSessionEvent).toHaveBeenCalledWith('headless-1', 'agent:event', data);

    session.attachedAdapters.push('sse');
    await expect(relayHeadlessSessionEvent(core, adapter, 'agent:event', data)).resolves.toBe(false);
    expect(adapter.sendSessionEvent).toHaveBeenCalledOnce();
  });
});
