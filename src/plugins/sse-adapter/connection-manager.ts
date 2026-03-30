import type { ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'

export interface SSEConnection {
  id: string
  sessionId: string
  tokenId: string
  response: ServerResponse
  connectedAt: Date
  lastEventId?: string
}

export class ConnectionManager {
  private connections = new Map<string, SSEConnection>()
  private sessionIndex = new Map<string, Set<string>>()

  addConnection(sessionId: string, tokenId: string, response: ServerResponse): SSEConnection {
    const id = `conn_${randomBytes(8).toString('hex')}`
    const connection: SSEConnection = {
      id,
      sessionId,
      tokenId,
      response,
      connectedAt: new Date(),
    }

    this.connections.set(id, connection)

    let sessionConns = this.sessionIndex.get(sessionId)
    if (!sessionConns) {
      sessionConns = new Set()
      this.sessionIndex.set(sessionId, sessionConns)
    }
    sessionConns.add(id)

    response.on('close', () => {
      this.removeConnection(id)
    })

    return connection
  }

  removeConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId)
    if (!conn) return

    this.connections.delete(connectionId)
    const sessionConns = this.sessionIndex.get(conn.sessionId)
    if (sessionConns) {
      sessionConns.delete(connectionId)
      if (sessionConns.size === 0) {
        this.sessionIndex.delete(conn.sessionId)
      }
    }
  }

  getConnectionsBySession(sessionId: string): SSEConnection[] {
    const connIds = this.sessionIndex.get(sessionId)
    if (!connIds) return []
    return Array.from(connIds)
      .map((id) => this.connections.get(id))
      .filter((c): c is SSEConnection => c !== undefined)
  }

  broadcast(sessionId: string, serializedEvent: string): void {
    const connections = this.getConnectionsBySession(sessionId)
    for (const conn of connections) {
      if (!conn.response.writableEnded) {
        try {
          conn.response.write(serializedEvent)
        } catch {
          // Connection closed
        }
      }
    }
  }

  disconnectByToken(tokenId: string): void {
    const toRemove: string[] = []
    for (const [id, conn] of this.connections) {
      if (conn.tokenId === tokenId) {
        if (!conn.response.writableEnded) {
          conn.response.end()
        }
        toRemove.push(id)
      }
    }
    for (const id of toRemove) {
      this.removeConnection(id)
    }
  }

  listConnections(): SSEConnection[] {
    return Array.from(this.connections.values())
  }

  cleanup(): void {
    for (const conn of this.connections.values()) {
      if (!conn.response.writableEnded) {
        conn.response.end()
      }
    }
    this.connections.clear()
    this.sessionIndex.clear()
  }
}
