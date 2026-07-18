import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SSEAdapter } from '../adapter.js';
import type { ConnectionManager } from '../connection-manager.js';
import type { EventBuffer } from '../event-buffer.js';
import type { OutgoingMessage, PermissionRequest, NotificationMessage, ElicitationRequest } from '../../../core/types.js';
import { deliverAgentActionControlParts } from '../../../core/agent-action-delivery.js';

function createMockConnectionManager(): ConnectionManager {
  return {
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    getConnectionsBySession: vi.fn().mockReturnValue([]),
    isConnectionCurrent: vi.fn().mockReturnValue(true),
    sendToConnections: vi.fn((connections: unknown[]) => connections.length),
    broadcast: vi.fn(),
    broadcastWhere: vi.fn(),
    disconnectByToken: vi.fn(),
    listConnections: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
  } as unknown as ConnectionManager;
}

function createMockEventBuffer(): EventBuffer {
  return {
    push: vi.fn(),
    getSince: vi.fn().mockReturnValue([]),
    cleanup: vi.fn(),
  } as unknown as EventBuffer;
}

describe('SSEAdapter', () => {
  let adapter: SSEAdapter;
  let connMgr: ReturnType<typeof createMockConnectionManager>;
  let eventBuf: ReturnType<typeof createMockEventBuffer>;

  beforeEach(() => {
    vi.useFakeTimers();
    connMgr = createMockConnectionManager();
    eventBuf = createMockEventBuffer();
    adapter = new SSEAdapter(connMgr, eventBuf);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('properties', () => {
    it('has name "sse"', () => {
      expect(adapter.name).toBe('sse');
    });

    it('has correct capabilities', () => {
      expect(adapter.capabilities).toEqual({
        streaming: true,
        richFormatting: false,
        threads: true,
        reactions: false,
        fileUpload: false,
        voice: false,
        elicitation: { form: true, secureInput: 'none' },
      });
    });
  });

  describe('sendMessage', () => {
    it('serializes, buffers, and broadcasts message', async () => {
      const message: OutgoingMessage = { type: 'text', text: 'hello' };
      await adapter.sendMessage('sess-1', message);

      expect(eventBuf.push).toHaveBeenCalledOnce();
      expect(eventBuf.push).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        id: expect.stringContaining('evt_'),
      }));

      expect(connMgr.broadcast).toHaveBeenCalledOnce();
      expect(connMgr.broadcast).toHaveBeenCalledWith('sess-1', expect.stringContaining('event: message'));
    });
  });

  describe('sendSessionEvent', () => {
    it('buffers and broadcasts headless core events using their documented event name', async () => {
      await adapter.sendSessionEvent('sess-1', 'agent:event', {
        sessionId: 'sess-1', turnId: 'turn-1', event: { type: 'text', text: 'hello' },
      });

      expect(eventBuf.push).toHaveBeenCalledOnce();
      expect(connMgr.broadcast).toHaveBeenCalledWith(
        'sess-1',
        expect.stringContaining('event: agent:event'),
      );
    });
  });

  describe('agent action target binding', () => {
    it('writes only to the captured connection snapshot and never buffers for future connections', async () => {
      const oldConnection = { id: 'old', sessionId: 'sess-1', response: { writableEnded: false } } as any;
      const newConnection = { id: 'new', sessionId: 'sess-1', response: { writableEnded: false } } as any;
      vi.mocked(connMgr.getConnectionsBySession).mockReturnValue([oldConnection]);
      let current = true;
      const context = {
        target: Object.freeze({
          sessionId: 'sess-1', adapterId: 'sse', threadId: 'sess-1',
          attachmentGeneration: 1, agentGeneration: 1, actionEpoch: 1,
        }),
        isCurrent: () => current,
      };
      const response = {
        type: 'agent_action_control' as const,
        action: 'skills',
        status: 'completed' as const,
        chunks: ['one'],
      };
      const binding = adapter.bindAgentActionControlTarget(context)!;
      vi.mocked(connMgr.getConnectionsBySession).mockReturnValue([newConnection]);

      const result = await deliverAgentActionControlParts(
        response,
        response.chunks,
        { target: context.target, isCurrent: () => current && binding.isCurrent() },
        (part, index) => binding.sendPart(response, part, index),
      );

      expect(result).toMatchObject({ status: 'completed', deliveredParts: 1 });
      expect(connMgr.sendToConnections).toHaveBeenCalledWith(
        [oldConnection],
        expect.stringContaining('event: agent_action_control'),
      );
      expect(connMgr.sendToConnections).not.toHaveBeenCalledWith(
        expect.arrayContaining([newConnection]),
        expect.anything(),
      );
      expect(eventBuf.push).not.toHaveBeenCalled();
      expect(connMgr.broadcast).not.toHaveBeenCalled();
      current = false;
    });
  });

  describe('sendPermissionRequest', () => {
    it('serializes, buffers, and broadcasts permission request', async () => {
      const request: PermissionRequest = {
        id: 'perm-1',
        description: 'Allow file write?',
        options: [
          { id: 'allow', label: 'Allow', isAllow: true },
          { id: 'deny', label: 'Deny', isAllow: false },
        ],
      };
      await adapter.sendPermissionRequest('sess-1', request);

      expect(eventBuf.push).toHaveBeenCalledOnce();
      expect(connMgr.broadcast).toHaveBeenCalledOnce();
      expect(connMgr.broadcast).toHaveBeenCalledWith('sess-1', expect.stringContaining('permission_request'));
    });
  });

  describe('structured input ownership', () => {
    it('delivers transient requests only to the owning principal without buffering owner metadata', async () => {
      const request: ElicitationRequest = {
        id: 'input-1',
        sessionId: 'sess-1',
        mode: 'form',
        message: 'Enter token',
        requestedSchema: {
          type: 'object',
          properties: { token: { type: 'string' } },
          required: ['token'],
        },
        targetAdapterId: 'sse',
        sensitiveFields: ['token'],
        owner: {
          adapterId: 'api',
          apiCredential: 'jwt',
          apiTokenId: 'owner-token',
          canonicalUserId: 'owner-user',
        },
      };

      await adapter.sendElicitationRequest('sess-1', request);

      expect(eventBuf.push).not.toHaveBeenCalled();
      expect(connMgr.broadcastWhere).toHaveBeenCalledOnce();
      const [, serialized, mayReceive] = vi.mocked(connMgr.broadcastWhere).mock.calls[0];
      expect(serialized).toContain('event: elicitation_request');
      expect(serialized).not.toContain('owner-token');
      expect(serialized).not.toContain('owner-user');
      expect(serialized).not.toContain('"owner"');
      expect(mayReceive({ authType: 'jwt', tokenId: 'attacker', userId: 'attacker' } as any)).toBe(false);
      expect(mayReceive({ authType: 'jwt', tokenId: 'owner-token' } as any)).toBe(true);
      expect(mayReceive({ authType: 'jwt', tokenId: 'peer-token', userId: 'owner-user' } as any)).toBe(true);
      expect(mayReceive({ authType: 'secret', tokenId: 'master-secret' } as any)).toBe(true);

      vi.mocked(connMgr.broadcastWhere).mockClear();
      await adapter.dismissElicitationRequest('sess-1', {
        requestId: 'input-1',
        sessionId: 'sess-1',
        action: 'accept',
        resolvedBy: 'user:owner-user',
      });
      const [, resolution, mayReceiveResolution] = vi.mocked(connMgr.broadcastWhere).mock.calls[0];
      expect(eventBuf.push).not.toHaveBeenCalled();
      expect(resolution).toContain('event: elicitation_resolved');
      expect(resolution).not.toContain('token');
      expect(mayReceiveResolution({ authType: 'jwt', tokenId: 'attacker' } as any)).toBe(false);
      expect(mayReceiveResolution({ authType: 'jwt', tokenId: 'owner-token' } as any)).toBe(true);
    });
  });

  describe('sendNotification', () => {
    it('buffers and broadcasts notification to session connections', async () => {
      const notification: NotificationMessage = {
        sessionId: 'sess-1',
        type: 'completed',
        summary: 'Session completed',
      };
      await adapter.sendNotification(notification);

      expect(eventBuf.push).toHaveBeenCalledOnce();
      expect(eventBuf.push).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        id: expect.stringContaining('evt_'),
      }));
      expect(connMgr.broadcast).toHaveBeenCalledOnce();
      expect(connMgr.broadcast).toHaveBeenCalledWith('sess-1', expect.stringContaining('event: notification'));
    });

    it('buffers and broadcasts even when no session connections exist', async () => {
      (connMgr.getConnectionsBySession as any).mockReturnValue([]);

      const notification: NotificationMessage = {
        sessionId: 'sess-1',
        type: 'error',
        summary: 'Something failed',
      };
      await adapter.sendNotification(notification);

      // Notification must be buffered so reconnecting clients receive missed events
      expect(eventBuf.push).toHaveBeenCalledOnce();
      expect(eventBuf.push).toHaveBeenCalledWith('sess-1', expect.objectContaining({
        id: expect.stringContaining('evt_'),
      }));
      // broadcast is still called (no-op if no connections are listening)
      expect(connMgr.broadcast).toHaveBeenCalledOnce();
      expect(connMgr.broadcast).toHaveBeenCalledWith('sess-1', expect.stringContaining('event: notification'));
    });
  });

  describe('createSessionThread', () => {
    it('returns sessionId as threadId', async () => {
      const threadId = await adapter.createSessionThread('sess-123', 'My Session');
      expect(threadId).toBe('sess-123');
    });
  });

  describe('renameSessionThread', () => {
    it('is a no-op', async () => {
      await expect(adapter.renameSessionThread('sess-1', 'New Name')).resolves.toBeUndefined();
    });
  });

  describe('start/stop lifecycle', () => {
    it('starts heartbeat on start and stops on stop', async () => {
      const mockConn = { response: { writableEnded: false, write: vi.fn() } };
      (connMgr.listConnections as any).mockReturnValue([mockConn]);

      await adapter.start();

      // Advance past heartbeat interval
      vi.advanceTimersByTime(30_000);
      expect(mockConn.response.write).toHaveBeenCalledWith(expect.stringContaining('heartbeat'));

      await adapter.stop();
      expect(connMgr.cleanup).toHaveBeenCalledOnce();

      // Verify heartbeat stopped
      mockConn.response.write.mockClear();
      vi.advanceTimersByTime(30_000);
      expect(mockConn.response.write).not.toHaveBeenCalled();
    });
  });
});
