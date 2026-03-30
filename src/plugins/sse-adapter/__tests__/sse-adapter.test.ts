import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventBuffer } from '../event-buffer.js'
import { ConnectionManager } from '../connection-manager.js'
import { SSEAdapter } from '../adapter.js'
import { serializeSSE, serializeOutgoingMessage, serializePermissionRequest } from '../event-serializer.js'
import type { ServerResponse } from 'node:http'

// ========================
// Event Serializer
// ========================

describe('event-serializer', () => {
  it('serializes a basic SSE event', () => {
    const result = serializeSSE('message', 'evt_001', { type: 'text', content: 'Hello' })
    expect(result).toBe('event: message\nid: evt_001\ndata: {"type":"text","content":"Hello"}\n\n')
  })

  it('serializes SSE event without ID', () => {
    const result = serializeSSE('heartbeat', undefined, { timestamp: '2026-03-31T00:00:00Z' })
    expect(result).toBe('event: heartbeat\ndata: {"timestamp":"2026-03-31T00:00:00Z"}\n\n')
  })

  it('serializes outgoing text message', () => {
    const result = serializeOutgoingMessage('sess_1', 'evt_002', {
      type: 'text',
      text: 'Hello world',
    } as any)
    expect(result).toContain('event: message')
    expect(result).toContain('id: evt_002')
    expect(result).toContain('"type":"text"')
    expect(result).toContain('"sessionId":"sess_1"')
  })

  it('serializes permission request', () => {
    const result = serializePermissionRequest('sess_1', 'evt_003', {
      id: 'perm_1',
      description: 'Run npm install',
      options: [{ id: 'allow', label: 'Allow', isAllow: true }],
    })
    expect(result).toContain('event: permission_request')
    expect(result).toContain('"id":"perm_1"')
  })
})

// ========================
// Event Buffer
// ========================

describe('EventBuffer', () => {
  it('stores events per session', () => {
    const buffer = new EventBuffer(100)
    buffer.push('sess_1', { id: 'evt_1', data: 'hello' })
    buffer.push('sess_1', { id: 'evt_2', data: 'world' })
    buffer.push('sess_2', { id: 'evt_3', data: 'other' })

    const events = buffer.getSince('sess_1', undefined)
    expect(events).toHaveLength(2)
  })

  it('returns events since a given ID', () => {
    const buffer = new EventBuffer(100)
    buffer.push('sess_1', { id: 'evt_1', data: 'a' })
    buffer.push('sess_1', { id: 'evt_2', data: 'b' })
    buffer.push('sess_1', { id: 'evt_3', data: 'c' })

    const events = buffer.getSince('sess_1', 'evt_1')
    expect(events).toHaveLength(2)
    expect(events![0].id).toBe('evt_2')
    expect(events![1].id).toBe('evt_3')
  })

  it('returns empty array for unknown session', () => {
    const buffer = new EventBuffer(100)
    expect(buffer.getSince('unknown', undefined)).toHaveLength(0)
  })

  it('evicts oldest events when buffer is full', () => {
    const buffer = new EventBuffer(3)
    buffer.push('sess_1', { id: 'evt_1', data: 'a' })
    buffer.push('sess_1', { id: 'evt_2', data: 'b' })
    buffer.push('sess_1', { id: 'evt_3', data: 'c' })
    buffer.push('sess_1', { id: 'evt_4', data: 'd' })

    const all = buffer.getSince('sess_1', undefined)
    expect(all).toHaveLength(3)
    expect(all![0].id).toBe('evt_2')
  })

  it('returns null when requested ID was evicted', () => {
    const buffer = new EventBuffer(2)
    buffer.push('sess_1', { id: 'evt_1', data: 'a' })
    buffer.push('sess_1', { id: 'evt_2', data: 'b' })
    buffer.push('sess_1', { id: 'evt_3', data: 'c' })

    expect(buffer.getSince('sess_1', 'evt_1')).toBeNull()
  })

  it('cleans up a session buffer', () => {
    const buffer = new EventBuffer(100)
    buffer.push('sess_1', { id: 'evt_1', data: 'a' })
    buffer.cleanup('sess_1')
    expect(buffer.getSince('sess_1', undefined)).toHaveLength(0)
  })
})

// ========================
// Connection Manager
// ========================

function mockResponse(): ServerResponse {
  return {
    write: vi.fn().mockReturnValue(true),
    end: vi.fn(),
    on: vi.fn(),
    writableEnded: false,
  } as any
}

describe('ConnectionManager', () => {
  let manager: ConnectionManager

  beforeEach(() => {
    manager = new ConnectionManager()
  })

  it('adds a connection and retrieves by session', () => {
    const res = mockResponse()
    const conn = manager.addConnection('sess_1', 'tok_1', res)
    expect(conn.id).toBeDefined()
    expect(conn.sessionId).toBe('sess_1')

    const conns = manager.getConnectionsBySession('sess_1')
    expect(conns).toHaveLength(1)
  })

  it('supports multiple connections per session', () => {
    manager.addConnection('sess_1', 'tok_1', mockResponse())
    manager.addConnection('sess_1', 'tok_2', mockResponse())
    expect(manager.getConnectionsBySession('sess_1')).toHaveLength(2)
  })

  it('removes a connection', () => {
    const conn = manager.addConnection('sess_1', 'tok_1', mockResponse())
    manager.removeConnection(conn.id)
    expect(manager.getConnectionsBySession('sess_1')).toHaveLength(0)
  })

  it('broadcasts to all connections for a session', () => {
    const res1 = mockResponse()
    const res2 = mockResponse()
    manager.addConnection('sess_1', 'tok_1', res1)
    manager.addConnection('sess_1', 'tok_2', res2)

    manager.broadcast('sess_1', 'event: test\ndata: hello\n\n')
    expect(res1.write).toHaveBeenCalledWith('event: test\ndata: hello\n\n')
    expect(res2.write).toHaveBeenCalledWith('event: test\ndata: hello\n\n')
  })

  it('does not broadcast to other sessions', () => {
    const res1 = mockResponse()
    const res2 = mockResponse()
    manager.addConnection('sess_1', 'tok_1', res1)
    manager.addConnection('sess_2', 'tok_2', res2)

    manager.broadcast('sess_1', 'event: test\ndata: hello\n\n')
    expect(res1.write).toHaveBeenCalled()
    expect(res2.write).not.toHaveBeenCalled()
  })

  it('disconnects all connections for a token', () => {
    const res1 = mockResponse()
    const res2 = mockResponse()
    manager.addConnection('sess_1', 'tok_1', res1)
    manager.addConnection('sess_2', 'tok_1', res2)
    manager.addConnection('sess_3', 'tok_2', mockResponse())

    manager.disconnectByToken('tok_1')
    expect(res1.end).toHaveBeenCalled()
    expect(res2.end).toHaveBeenCalled()
    expect(manager.getConnectionsBySession('sess_1')).toHaveLength(0)
    expect(manager.getConnectionsBySession('sess_2')).toHaveLength(0)
    expect(manager.getConnectionsBySession('sess_3')).toHaveLength(1)
  })

  it('returns empty array for unknown session', () => {
    expect(manager.getConnectionsBySession('unknown')).toHaveLength(0)
  })
})

// ========================
// SSE Adapter
// ========================

describe('SSEAdapter', () => {
  let adapter: SSEAdapter
  let connectionManager: ConnectionManager
  let eventBuffer: EventBuffer

  beforeEach(() => {
    connectionManager = new ConnectionManager()
    eventBuffer = new EventBuffer(100)
    adapter = new SSEAdapter(connectionManager, eventBuffer)
  })

  it('has correct name and capabilities', () => {
    expect(adapter.name).toBe('sse')
    expect(adapter.capabilities.streaming).toBe(true)
    expect(adapter.capabilities.richFormatting).toBe(false)
    expect(adapter.capabilities.threads).toBe(true)
  })

  it('sends message to all session connections', async () => {
    const res = mockResponse()
    connectionManager.addConnection('sess_1', 'tok_1', res)

    await adapter.sendMessage('sess_1', { type: 'text', text: 'Hello' } as any)
    expect(res.write).toHaveBeenCalled()
    const written = (res.write as any).mock.calls[0][0] as string
    expect(written).toContain('event: message')
  })

  it('buffers events for reconnect', async () => {
    connectionManager.addConnection('sess_1', 'tok_1', mockResponse())
    await adapter.sendMessage('sess_1', { type: 'text', text: 'Hello' } as any)

    const buffered = eventBuffer.getSince('sess_1', undefined)
    expect(buffered).toHaveLength(1)
  })

  it('sends permission request', async () => {
    const res = mockResponse()
    connectionManager.addConnection('sess_1', 'tok_1', res)

    await adapter.sendPermissionRequest('sess_1', {
      id: 'perm_1',
      description: 'Run npm install',
      options: [{ id: 'allow', label: 'Allow', isAllow: true }],
    })

    const written = (res.write as any).mock.calls[0][0] as string
    expect(written).toContain('event: permission_request')
  })

  it('createSessionThread returns sessionId', async () => {
    const threadId = await adapter.createSessionThread('sess_1', 'Test')
    expect(threadId).toBe('sess_1')
  })
})
