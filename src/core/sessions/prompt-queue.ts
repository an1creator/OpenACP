import type { Attachment, TurnMeta } from '../types.js'
import type { TurnRouting } from './turn-context.js'

/**
 * Serial prompt queue — ensures prompts are processed one at a time.
 *
 * Agents are stateful (each prompt builds on prior context), so concurrent
 * prompts would corrupt the conversation. This queue guarantees that only
 * one prompt is processed at a time; additional prompts are buffered and
 * drained sequentially after the current one completes.
 */
export class PromptQueue {
  private queue: Array<{ text: string; userPrompt: string; attachments?: Attachment[]; routing?: TurnRouting; turnId?: string; meta?: TurnMeta; resolve: () => void }> = []
  private processing = false
  private abortController: AbortController | null = null
  private abortBarrier: Promise<unknown> = Promise.resolve()
  private currentSettled: Promise<void> = Promise.resolve()
  private releaseTerminalWait: (() => void) | null = null
  private generationCounter = 0
  private activeGeneration: number | null = null
  private closed = false

  constructor(
    private processor: (text: string, userPrompt: string, attachments?: Attachment[], routing?: TurnRouting, turnId?: string, meta?: TurnMeta, signal?: AbortSignal) => Promise<void>,
    private onError?: (err: unknown) => void,
    // Fires synchronously when an item is placed behind a running prompt — before it's pushed
    // to the pending list. Called with accurate queue depth so callers can emit notifications
    // without a race condition on promptRunning state.
    private onActuallyQueued?: (turnId: string | undefined, position: number, routing: TurnRouting | undefined) => void,
  ) {}

  /**
   * Add a prompt to the queue. If no prompt is currently processing, it runs
   * immediately. Otherwise, it's buffered and the returned promise resolves
   * only after the prompt finishes processing.
   */
  submit(text: string, userPrompt: string, attachments?: Attachment[], routing?: TurnRouting, turnId?: string, meta?: TurnMeta): Promise<void> {
    if (this.closed) throw new Error('Prompt queue is closed')
    if (this.processing) {
      // Fire synchronously BEFORE pushing so the caller sees accurate position and promptRunning state.
      // This eliminates the race condition where multiple concurrent enqueue() calls all observe
      // processing=false before any of them sets it to true.
      const position = this.queue.length + 1;
      this.onActuallyQueued?.(turnId, position, routing);
      return new Promise<void>((resolve) => {
        this.queue.push({ text, userPrompt, attachments, routing, turnId, meta, resolve })
      })
    }
    return this.process(text, userPrompt, attachments, routing, turnId, meta)
  }

  async enqueue(text: string, userPrompt: string, attachments?: Attachment[], routing?: TurnRouting, turnId?: string, meta?: TurnMeta): Promise<void> {
    await this.submit(text, userPrompt, attachments, routing, turnId, meta)
  }

  /** Run a single prompt through the processor, then drain the next queued item. */
  private async process(text: string, userPrompt: string, attachments?: Attachment[], routing?: TurnRouting, turnId?: string, meta?: TurnMeta): Promise<void> {
    this.processing = true
    const generation = ++this.generationCounter
    this.activeGeneration = generation
    this.abortController = new AbortController()
    this.abortBarrier = Promise.resolve()
    let markSettled!: () => void
    const settled = new Promise<void>((resolve) => { markSettled = resolve })
    this.currentSettled = settled
    let releaseTerminalWait!: () => void
    const terminalRelease = new Promise<void>((resolve) => { releaseTerminalWait = resolve })
    this.releaseTerminalWait = releaseTerminalWait
    const { signal } = this.abortController
    const processorPromise = Promise.resolve().then(() => (
      signal.throwIfAborted(),
      this.processor(text, userPrompt, attachments, routing, turnId, meta, signal)
    ))
    let rejectAbort!: (error: Error) => void
    const abortPromise = new Promise<never>((_, reject) => { rejectAbort = reject })
    const onAbort = (): void => rejectAbort(new Error('Prompt aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.race([processorPromise, abortPromise])
    } catch (err) {
      if (!signal.aborted) this.onError?.(err)
    } finally {
      // Abort can race with an already-resolved processor before this continuation runs.
      // Re-read the barrier because concurrent callers may append teardown work while
      // the current generation is settling.
      if (signal.aborted) {
        const observeCleanup = async (): Promise<void> => {
          let observedBarrier: Promise<unknown>
          do {
            observedBarrier = this.abortBarrier
            await Promise.allSettled([processorPromise, observedBarrier])
          } while (observedBarrier !== this.abortBarrier)
        }
        // Terminal session teardown may have to abandon an ACP prompt that stays
        // pending even after its subprocess has been destroyed. The cleanup
        // promises remain observed, but releasing here lets enqueue()/close()
        // callers settle and prevents a detached promise leak.
        await Promise.race([observeCleanup(), terminalRelease])
      }
      signal.removeEventListener('abort', onAbort)
      this.abortController = null
      this.processing = false
      if (this.activeGeneration === generation) this.activeGeneration = null
      this.abortBarrier = Promise.resolve()
      if (this.releaseTerminalWait === releaseTerminalWait) this.releaseTerminalWait = null
      markSettled()
      if (this.currentSettled === settled) this.currentSettled = Promise.resolve()
      this.drainNext()
    }
  }

  /** Dequeue and process the next pending prompt, if any. Called after each prompt completes. */
  private drainNext(): void {
    if (this.closed) return
    const next = this.queue.shift()
    if (next) {
      this.process(next.text, next.userPrompt, next.attachments, next.routing, next.turnId, next.meta).then(next.resolve)
    }
  }

  /**
   * Abort only the in-flight prompt, keeping queued prompts intact.
   * The queue will automatically drain to the next item via `drainNext()`
   * in the `process()` finally block.
   *
   * @returns A promise that settles after the current processor and abort barrier finish.
   */
  abortCurrent(beforeDrain?: Promise<unknown>): Promise<void> {
    if (this.abortController) {
      if (beforeDrain) {
        const previousBarrier = this.abortBarrier
        this.abortBarrier = Promise.allSettled([previousBarrier, beforeDrain]).then(() => undefined)
      }
      this.abortController.abort()
    }
    return this.currentSettled
  }

  /**
   * Abort the in-flight prompt and discard all queued prompts.
   * Pending promises are resolved (not rejected) so callers don't see unhandled rejections.
   *
   * @returns A promise that settles after in-flight cleanup finishes.
   */
  clear(beforeDrain?: Promise<unknown>): Promise<void> {
    const settled = this.abortCurrent(beforeDrain)
    // Resolve pending promises so callers don't hang
    for (const item of this.queue) {
      item.resolve()
    }
    this.queue = []
    return settled
  }

  /**
   * Permanently close the queue for terminal session teardown.
   *
   * Pending callers are resolved immediately. The in-flight processor remains
   * observed through the returned promise, but even a late settlement cannot
   * drain another item or reopen the queue.
   */
  close(beforeDrain?: Promise<unknown>): Promise<void> {
    this.closed = true
    return this.clear(beforeDrain)
  }

  /**
   * Release terminal callers after the owning subprocess has been destroyed.
   * The processor and abort barriers stay rejection-observed if they settle late.
   */
  releaseAfterTerminalTeardown(): void {
    if (this.closed) this.releaseTerminalWait?.()
  }

  /**
   * Discard all queued prompts without aborting the in-flight prompt.
   * The currently processing prompt continues to completion; only pending
   * (not-yet-started) items are removed. Their promises are resolved
   * (not rejected) so callers don't see unhandled rejections.
   */
  clearPending(): void {
    for (const item of this.queue) {
      item.resolve()
    }
    this.queue = []
  }

  /**
   * Promote a specific queued item to the front and discard all others.
   *
   * Finds the item with the matching turnId, removes every other pending item
   * (resolving their promises), and leaves only the target in the queue.
   * Does NOT abort the in-flight prompt — caller handles that separately.
   *
   * @returns true if the item was found and promoted, false if not in queue
   */
  prioritize(turnId: string): boolean {
    const idx = this.queue.findIndex(item => item.turnId === turnId)
    if (idx === -1) return false
    const target = this.queue[idx]
    for (let i = 0; i < this.queue.length; i++) {
      if (i !== idx) this.queue[i].resolve()
    }
    this.queue = [target]
    return true
  }

  get pending(): number {
    return this.queue.length
  }

  get isProcessing(): boolean {
    return this.processing
  }

  /** Immutable identity for the prompt currently owned by the processor. */
  get currentGeneration(): number | null {
    return this.activeGeneration
  }

  /** Snapshot of queued (not yet processing) items — used for queue inspection by callers. */
  get pendingItems(): Array<{ userPrompt: string; turnId?: string }> {
    return this.queue.map(item => ({
      userPrompt: item.userPrompt,
      turnId: item.turnId,
    }))
  }
}
