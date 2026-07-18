import { describe, it, expect } from 'vitest';
import { serializeSSE, serializeOutgoingMessage, serializePermissionRequest, serializeElicitationRequest, serializeElicitationResolved } from '../event-serializer.js';

describe('event-serializer', () => {
  it('serializes a basic SSE event', () => {
    const result = serializeSSE('message', 'evt_001', { type: 'text', content: 'Hello' });
    expect(result).toBe('event: message\nid: evt_001\ndata: {"type":"text","content":"Hello"}\n\n');
  });

  it('serializes SSE event without ID', () => {
    const result = serializeSSE('heartbeat', undefined, { timestamp: '2026-03-31T00:00:00Z' });
    expect(result).toBe('event: heartbeat\ndata: {"timestamp":"2026-03-31T00:00:00Z"}\n\n');
  });

  it('serializes outgoing text message', () => {
    const result = serializeOutgoingMessage('sess_1', 'evt_002', { type: 'text', text: 'Hello world' } as any);
    expect(result).toContain('event: message');
    expect(result).toContain('id: evt_002');
    expect(result).toContain('"type":"text"');
    expect(result).toContain('"sessionId":"sess_1"');
  });

  it('serializes permission request', () => {
    const result = serializePermissionRequest('sess_1', 'evt_003', {
      id: 'perm_1',
      description: 'Run npm install',
      options: [{ id: 'allow', label: 'Allow', isAllow: true }],
    });
    expect(result).toContain('event: permission_request');
    expect(result).toContain('"id":"perm_1"');
  });

  it('serializes elicitation request without owner metadata or submitted content', () => {
    const result = serializeElicitationRequest('sess_1', 'evt_004', {
      id: 'input-1', sessionId: 'sess_1', mode: 'form', message: 'Choose', expiresAt: 123,
      owner: { adapterId: 'api', apiCredential: 'jwt', apiTokenId: 'token-1' },
      requestedSchema: { type: 'object', properties: { answer: { type: 'string' } } },
    });
    expect(result).toContain('event: elicitation_request');
    expect(result).not.toContain('token-1');
    expect(result).not.toContain('owner');

    const resolved = serializeElicitationResolved('evt_005', {
      sessionId: 'sess_1', requestId: 'input-1', action: 'accept', reason: 'user',
    });
    expect(resolved).toContain('event: elicitation_resolved');
    expect(resolved).not.toContain('content');
  });
});
