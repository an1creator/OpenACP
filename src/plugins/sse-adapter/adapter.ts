import type { IChannelAdapter, AdapterCapabilities } from '../../core/channel.js'
import type { OutgoingMessage, PermissionRequest, NotificationMessage } from '../../core/types.js'
import type { ConnectionManager } from './connection-manager.js'
import type { EventBuffer } from './event-buffer.js'
import {
  generateEventId,
  serializeOutgoingMessage,
  serializePermissionRequest,
  serializeSSE,
  serializeHeartbeat,
} from './event-serializer.js'

export class SSEAdapter implements IChannelAdapter {
  readonly name = 'sse'
  readonly capabilities: AdapterCapabilities = {
    streaming: true,
    richFormatting: false,
    threads: true,
    reactions: false,
    fileUpload: false,
    voice: false,
  }

  private heartbeatInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    private connectionManager: ConnectionManager,
    private eventBuffer: EventBuffer,
  ) {}

  async sendMessage(sessionId: string, message: OutgoingMessage): Promise<void> {
    const eventId = generateEventId()
    const serialized = serializeOutgoingMessage(sessionId, eventId, message)

    this.eventBuffer.push(sessionId, { id: eventId, data: serialized })
    this.connectionManager.broadcast(sessionId, serialized)
  }

  async sendPermissionRequest(sessionId: string, request: PermissionRequest): Promise<void> {
    const eventId = generateEventId()
    const serialized = serializePermissionRequest(sessionId, eventId, request)

    this.eventBuffer.push(sessionId, { id: eventId, data: serialized })
    this.connectionManager.broadcast(sessionId, serialized)
  }

  async sendNotification(notification: NotificationMessage): Promise<void> {
    const eventId = generateEventId()
    const sessionId = notification.sessionId
    const serialized = serializeSSE('notification', eventId, notification)

    if (sessionId) {
      this.eventBuffer.push(sessionId, { id: eventId, data: serialized })
      this.connectionManager.broadcast(sessionId, serialized)
    }
  }

  async createSessionThread(sessionId: string, _name: string): Promise<string> {
    return sessionId
  }

  async renameSessionThread(_sessionId: string, _newName: string): Promise<void> {
    // No-op — client tracks via session_update events
  }

  async start(): Promise<void> {
    this.heartbeatInterval = setInterval(() => {
      const heartbeat = serializeHeartbeat()
      for (const conn of this.connectionManager.listConnections()) {
        if (!conn.response.writableEnded) {
          try {
            conn.response.write(heartbeat)
          } catch {
            // Connection closed
          }
        }
      }
    }, 30_000)
  }

  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = null
    }
    this.connectionManager.cleanup()
  }
}
