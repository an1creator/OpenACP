export interface BufferedEvent {
  id: string
  data: unknown
}

export class EventBuffer {
  private buffers = new Map<string, BufferedEvent[]>()

  constructor(private maxSize: number = 100) {}

  push(sessionId: string, event: BufferedEvent): void {
    let buffer = this.buffers.get(sessionId)
    if (!buffer) {
      buffer = []
      this.buffers.set(sessionId, buffer)
    }

    buffer.push(event)

    while (buffer.length > this.maxSize) {
      buffer.shift()
    }
  }

  /**
   * Get events since a given event ID.
   * Returns null if the requested ID was evicted (client missed too many events).
   * Returns all events if lastEventId is undefined.
   */
  getSince(sessionId: string, lastEventId: string | undefined): BufferedEvent[] | null {
    const buffer = this.buffers.get(sessionId)
    if (!buffer || buffer.length === 0) return []

    if (lastEventId === undefined) {
      return [...buffer]
    }

    const index = buffer.findIndex((e) => e.id === lastEventId)
    if (index === -1) {
      return null // Event was evicted
    }

    return buffer.slice(index + 1)
  }

  cleanup(sessionId: string): void {
    this.buffers.delete(sessionId)
  }
}
