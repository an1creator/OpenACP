import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { SSEManager } from '../sse-manager.js';
import { BusEvent } from '../../../core/events.js';

function connection() {
  const req = Object.assign(new EventEmitter(), {
    url: '/api/v1/events',
    headers: {},
  }) as any;
  const res = Object.assign(new EventEmitter(), {
    writable: true,
    writableEnded: false,
    socket: { setNoDelay: vi.fn() },
    writeHead: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
  }) as any;
  return { req, res };
}

describe('SSEManager elicitation ownership', () => {
  it('keeps global form events administrative while preserving ordinary JWT events', () => {
    const manager = new SSEManager(undefined, () => ({ active: 0, total: 0 }), Date.now());
    const admin = connection();
    const jwt = connection();
    manager.handleRequest(admin.req, admin.res, { authType: 'secret' });
    manager.handleRequest(jwt.req, jwt.res, { authType: 'jwt' });
    admin.res.write.mockClear();
    jwt.res.write.mockClear();

    manager.broadcast(BusEvent.ELICITATION_REQUEST, {
      sessionId: 'headless-1',
      request: { id: 'input-1', message: 'Enter protected input' },
    });

    expect(admin.res.write).toHaveBeenCalledWith(expect.stringContaining('Enter protected input'));
    expect(jwt.res.write).not.toHaveBeenCalled();

    manager.broadcast(BusEvent.AGENT_EVENT, {
      sessionId: 'headless-1', turnId: 'turn-1', event: { type: 'text', text: 'safe output' },
    });
    expect(admin.res.write).toHaveBeenCalledWith(expect.stringContaining('safe output'));
    expect(jwt.res.write).toHaveBeenCalledWith(expect.stringContaining('safe output'));
    manager.stop();
  });
});
