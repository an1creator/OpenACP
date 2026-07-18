import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SessionBridge } from '../session-bridge.js'
import { MessageTransformer } from '../../message-transformer.js'
import type { IChannelAdapter } from '../../channel.js'
import type { Session } from '../session.js'
import type { AgentEvent } from '../../types.js'
import { TypedEmitter } from '../../utils/typed-emitter.js'
import { ElicitationGate } from '../elicitation-gate.js'

function createMockSession() {
  const emitter = new TypedEmitter()
  return Object.assign(emitter, {
    id: 'test-session',
    channelId: 'telegram',
    name: 'Test',
    threadId: '123',
    agentName: 'claude',
    agentSessionId: 'agent-1',
    workingDirectory: '/tmp',
    status: 'active',
    isTerminating: false,
    agentGeneration: 0,
    createdAt: new Date(),
    promptCount: 0,
    configOptions: [],
    clientOverrides: {},
    permissionGate: { setPending: vi.fn() },
    elicitationGate: new ElicitationGate(),
    agentInstance: Object.assign(new TypedEmitter(), {
      sessionId: 'agent-1',
      on: vi.fn(),
      off: vi.fn(),
      onPermissionRequest: vi.fn(),
    }),
    setName: vi.fn(),
    captureAgentTitleContext: vi.fn().mockReturnValue({
      turnId: null, userPrompt: '', finalPrompt: '', nameRevision: 0,
    }),
    applyAgentTitle: vi.fn((title: string) => ({ status: 'accepted', name: title })),
    finish: vi.fn(),
    fail: vi.fn(),
    registerBridge: vi.fn(),
    unregisterBridge: vi.fn(),
    getConfigByCategory: vi.fn(),
    updateConfigOptions: vi.fn().mockResolvedValue(undefined),
    toAcpStateSnapshot: vi.fn().mockReturnValue({}),
  }) as unknown as Session
}

function createMockAdapter(): IChannelAdapter {
  return {
    name: 'test',
    capabilities: { streaming: false, richFormatting: false, threads: false, reactions: false, fileUpload: false, voice: false },
    start: vi.fn(),
    stop: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPermissionRequest: vi.fn().mockResolvedValue(undefined),
    sendNotification: vi.fn().mockResolvedValue(undefined),
    createSessionThread: vi.fn().mockResolvedValue('thread-1'),
    renameSessionThread: vi.fn().mockResolvedValue(undefined),
  } as unknown as IChannelAdapter
}

describe('SessionBridge ACP events', () => {
  let session: ReturnType<typeof createMockSession>
  let adapter: IChannelAdapter
  let bridge: SessionBridge
  let mockPatchRecord: ReturnType<typeof vi.fn>

  beforeEach(() => {
    session = createMockSession()
    adapter = createMockAdapter()
    mockPatchRecord = vi.fn()
    bridge = new SessionBridge(session as unknown as Session, adapter, {
      messageTransformer: new MessageTransformer(),
      notificationManager: { notify: vi.fn() } as any,
      sessionManager: { patchRecord: mockPatchRecord } as any,
    })
    bridge.connect()
  })

  afterEach(() => {
    bridge.disconnect()
  })

  it('registers and unregisters the exact adapter owner', () => {
    expect(session.registerBridge).toHaveBeenCalledOnce()
    expect(session.registerBridge).toHaveBeenCalledWith('test')

    bridge.disconnect()

    expect(session.unregisterBridge).toHaveBeenCalledOnce()
    expect(session.unregisterBridge).toHaveBeenCalledWith('test')
  })

  it('session_info_update with title applies the naming policy and sends message', async () => {
    const event: AgentEvent = { type: 'session_info_update', title: 'New Title' }
    session.emit('agent_event', event)
    await vi.waitFor(() => {
      expect(session.applyAgentTitle).toHaveBeenCalledWith(
        'New Title',
        expect.objectContaining({ nameRevision: 0 }),
      )
      expect(adapter.sendMessage).toHaveBeenCalled()
    })
  })

  it('session_info_update without title silently updates state without notifying adapter', async () => {
    const event: AgentEvent = { type: 'session_info_update', updatedAt: '2026-03-26' }
    session.emit('agent_event', event)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(session.applyAgentTitle).not.toHaveBeenCalled()
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('config_option_update calls updateConfigOptions, persists ACP state, and sends message', async () => {
    const event: AgentEvent = {
      type: 'config_option_update',
      options: [{ id: 'model', name: 'Model', type: 'select', currentValue: 'sonnet', options: [] }],
    }
    session.emit('agent_event', event)
    await vi.waitFor(() => {
      expect(session.updateConfigOptions).toHaveBeenCalled()
      expect(mockPatchRecord).toHaveBeenCalledWith(
        'test-session',
        expect.objectContaining({ acpState: expect.anything() }),
        { expectedSession: session },
      )
      expect(adapter.sendMessage).toHaveBeenCalledWith('test-session', expect.objectContaining({ type: 'config_update' }))
    })
  })

  it('does NOT handle current_mode_update event (removed from AgentEvent type)', () => {
    // current_mode_update is no longer a valid AgentEvent type.
    // Emitting it should not call updateMode (which no longer exists on Session).
    // This test verifies the bridge doesn't have a handler for it.
    const event = { type: 'current_mode_update', modeId: 'architect' } as any
    session.emit('agent_event', event)
    // updateMode no longer exists on mock, so just verify no crash and
    // message was NOT sent (no case matches in switch)
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('does NOT handle model_update event (removed from AgentEvent type)', () => {
    // model_update is no longer a valid AgentEvent type.
    const event = { type: 'model_update', modelId: 'opus' } as any
    session.emit('agent_event', event)
    // No handler should match
    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it('user_message_chunk sends message to adapter', async () => {
    const event: AgentEvent = { type: 'user_message_chunk', content: 'Hello' }
    session.emit('agent_event', event)
    await vi.waitFor(() => {
      expect(adapter.sendMessage).toHaveBeenCalledWith('test-session', expect.objectContaining({ type: 'user_replay' }))
    })
  })

  it('resource_content sends message to adapter', async () => {
    const event: AgentEvent = { type: 'resource_content', uri: 'file:///a.txt', name: 'a.txt', text: 'hi' }
    session.emit('agent_event', event)
    await vi.waitFor(() => {
      expect(adapter.sendMessage).toHaveBeenCalledWith('test-session', expect.objectContaining({ type: 'resource' }))
    })
  })

  it('resource_link sends message to adapter', async () => {
    const event: AgentEvent = { type: 'resource_link', uri: 'https://ex.com', name: 'Ex' }
    session.emit('agent_event', event)
    await vi.waitFor(() => {
      expect(adapter.sendMessage).toHaveBeenCalledWith('test-session', expect.objectContaining({ type: 'resource_link' }))
    })
  })

  it('fails closed for connector protected input without an initiating user', async () => {
    adapter.capabilities.elicitation = { form: true, secureInput: 'delete-after-capture' }
    adapter.sendElicitationRequest = vi.fn().mockResolvedValue(undefined)
    const response = session.elicitationGate.request({
      id: 'secret-no-owner',
      sessionId: session.id,
      targetAdapterId: 'test',
      mode: 'form',
      message: 'Credential',
      sensitiveFields: ['token'],
      owner: { adapterId: 'test' },
      requestedSchema: {
        type: 'object',
        properties: { token: { type: 'string' } },
        required: ['token'],
      },
    })

    session.emit('elicitation_request', session.elicitationGate.get('secret-no-owner'))

    await expect(response).resolves.toEqual({ action: 'cancel' })
    expect(adapter.sendElicitationRequest).not.toHaveBeenCalled()
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      session.id,
      expect.objectContaining({ text: expect.stringContaining('cannot capture it safely') }),
    )
  })

  it('routes API-owned protected input to REST instead of a connector capture flow', async () => {
    adapter.capabilities.elicitation = { form: true, secureInput: 'delete-after-capture' }
    adapter.sendElicitationRequest = vi.fn().mockResolvedValue(undefined)
    const response = session.elicitationGate.request({
      id: 'secret-api',
      sessionId: session.id,
      targetAdapterId: 'test',
      mode: 'form',
      message: 'Credential',
      sensitiveFields: ['token'],
      owner: { adapterId: 'sse', apiCredential: 'jwt', apiTokenId: 'jwt-1' },
      requestedSchema: {
        type: 'object',
        properties: { token: { type: 'string' } },
        required: ['token'],
      },
    })

    session.emit('elicitation_request', session.elicitationGate.get('secret-api'))

    await vi.waitFor(() => {
      expect(adapter.sendMessage).toHaveBeenCalledWith(
        session.id,
        expect.objectContaining({ text: expect.stringContaining('authenticated REST endpoint') }),
      )
    })
    expect(adapter.sendElicitationRequest).not.toHaveBeenCalled()
    session.elicitationGate.cancel('secret-api')
    await expect(response).resolves.toEqual({ action: 'cancel' })
  })
})
