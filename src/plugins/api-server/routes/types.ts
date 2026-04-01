import type { preHandlerHookHandler } from 'fastify';
import type { OpenACPCore } from '../../../core/core.js';
import type { TopicManager } from '../../telegram/topic-manager.js';
import type { CommandRegistry } from '../../../core/command-registry.js';
import type { HistoryStore } from '../../context/history/history-store.js';

/**
 * Dependencies injected into Fastify route plugins.
 * Each route plugin receives these via its options parameter.
 */
export interface RouteDeps {
  core: OpenACPCore;
  topicManager?: TopicManager;
  startedAt: number;
  getVersion: () => string;
  commandRegistry?: CommandRegistry;
  /** Auth pre-handler for routes registered without global auth (e.g. system routes). */
  authPreHandler?: preHandlerHookHandler;
  /** History store for reading session conversation history. */
  historyStore?: HistoryStore;
}
