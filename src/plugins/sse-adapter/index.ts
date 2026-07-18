import type { OpenACPPlugin } from '../../core/plugin/types.js';
import type { OpenACPCore } from '../../core/core.js';
import type { ApiServerService } from '../api-server/service.js';
import type { CommandRegistry } from '../../core/command-registry.js';
import { ConnectionManager } from './connection-manager.js';
import { EventBuffer } from './event-buffer.js';
import { SSEAdapter } from './adapter.js';
import { sseRoutes } from './routes.js';
import { BusEvent } from '../../core/events.js';
import type { ElicitationRequest, ElicitationResolvedEvent } from '../../core/types.js';
import {
  HEADLESS_DELIVERY_CLAIM,
  type HeadlessClaimedPayload,
} from '../../core/sessions/session.js';

// Module-level references held for teardown — the plugin lifecycle doesn't
// pass instances between setup() and teardown(), so we store them here.
let _adapter: SSEAdapter | null = null;
let _connectionManager: ConnectionManager | null = null;

/** Relay transient form input only for API/headless sessions that have no SessionBridge. */
export async function relayHeadlessElicitationRequest(
  core: OpenACPCore,
  adapter: SSEAdapter,
  data: HeadlessClaimedPayload<{ sessionId: string; request: Pick<ElicitationRequest, 'id'> }>,
): Promise<boolean> {
  const session = core.sessionManager.getSession(data.sessionId);
  const claimed = session?.isHeadlessDeliveryClaimActive?.(data[HEADLESS_DELIVERY_CLAIM]) === true;
  if (
    !session
    || session.channelId !== 'api'
    || (session.attachedAdapters?.includes('sse') && !claimed)
  ) return false;
  const request = session.elicitationGate.get(data.request.id);
  if (!request || request.targetAdapterId !== 'sse') return false;
  await adapter.sendElicitationRequest(session.id, request);
  return true;
}

/** Dismiss an input form previously relayed for an API/headless session. */
export async function relayHeadlessElicitationResolved(
  core: OpenACPCore,
  adapter: SSEAdapter,
  event: HeadlessClaimedPayload<ElicitationResolvedEvent>,
): Promise<boolean> {
  const session = core.sessionManager.getSession(event.sessionId);
  const claimed = session?.isHeadlessDeliveryClaimActive?.(event[HEADLESS_DELIVERY_CLAIM]) === true;
  if (
    !session
    || session.channelId !== 'api'
    || (session.attachedAdapters?.includes('sse') && !claimed)
  ) return false;
  await adapter.dismissElicitationRequest(session.id, event);
  return true;
}

/** Relay ordinary core events for API/headless sessions that lack an SSE SessionBridge. */
export async function relayHeadlessSessionEvent(
  core: OpenACPCore,
  adapter: SSEAdapter,
  event: string,
  data: HeadlessClaimedPayload<{ sessionId: string }>,
): Promise<boolean> {
  const session = core.sessionManager.getSession(data.sessionId);
  const claimed = session?.isHeadlessDeliveryClaimActive?.(data[HEADLESS_DELIVERY_CLAIM]) === true;
  if (
    !session
    || session.channelId !== 'api'
    || (session.attachedAdapters.includes('sse') && !claimed)
  ) return false;
  await adapter.sendSessionEvent(session.id, event, data);
  return true;
}

const plugin: OpenACPPlugin = {
  name: '@openacp/sse-adapter',
  version: '1.0.0',
  description: 'SSE-based messaging adapter for app clients',
  pluginDependencies: {
    '@openacp/api-server': '^1.0.0',
    '@openacp/security': '^1.0.0',
    '@openacp/notifications': '^1.0.0',
  },
  permissions: ['services:register', 'services:use', 'kernel:access', 'events:read'],

  async setup(ctx) {
    const core = ctx.core as OpenACPCore;
    const apiServer = ctx.getService<ApiServerService>('api-server');

    if (!apiServer) {
      ctx.log.warn('API server not available, SSE adapter disabled');
      return;
    }

    const connectionManager = new ConnectionManager({ maxPerSession: 10, maxTotal: 100 });
    const eventBuffer = new EventBuffer(100);
    const adapter = new SSEAdapter(connectionManager, eventBuffer);

    _adapter = adapter;
    _connectionManager = connectionManager;

    // Register adapter as a service so main.ts wires it into core
    ctx.registerService('adapter:sse', adapter);

    // Get command registry for command execution in routes
    const commandRegistry = ctx.getService<CommandRegistry>('command-registry');

    // Clean up event buffer when a session ends or is deleted to prevent unbounded memory growth
    ctx.on(BusEvent.SESSION_DELETED, (data: unknown) => {
      const { sessionId } = data as { sessionId: string };
      eventBuffer.cleanup(sessionId);
      adapter.clearSessionElicitations(sessionId);
    });
    ctx.on(BusEvent.SESSION_ENDED, (data: unknown) => {
      const { sessionId } = data as { sessionId: string };
      eventBuffer.cleanup(sessionId);
      adapter.clearSessionElicitations(sessionId);
    });
    ctx.on(BusEvent.ELICITATION_REQUEST, (data: unknown) => {
      void relayHeadlessElicitationRequest(
        core,
        adapter,
        data as { sessionId: string; request: Pick<ElicitationRequest, 'id'> },
      ).catch((error) => {
        void error;
        ctx.log.warn('Failed to relay headless elicitation request');
      });
    });
    ctx.on(BusEvent.ELICITATION_RESOLVED, (data: unknown) => {
      void relayHeadlessElicitationResolved(core, adapter, data as ElicitationResolvedEvent).catch((error) => {
        void error;
        ctx.log.warn('Failed to relay headless elicitation resolution');
      });
    });
    const headlessSessionEvents = [
      BusEvent.AGENT_EVENT,
      BusEvent.PERMISSION_REQUEST,
      BusEvent.PERMISSION_RESOLVED,
      BusEvent.SESSION_UPDATED,
      BusEvent.MESSAGE_QUEUED,
      BusEvent.MESSAGE_PROCESSING,
      BusEvent.MESSAGE_FAILED,
      BusEvent.PROMPT_WAITING,
    ] as const;
    for (const event of headlessSessionEvents) {
      ctx.on(event, (data: unknown) => {
        void relayHeadlessSessionEvent(
          core,
          adapter,
          event,
          data as { sessionId: string },
        ).catch((error) => {
          void error;
          ctx.log.warn(`Failed to relay headless session event ${event}`);
        });
      });
    }

    // Register SSE routes on the api-server
    apiServer.registerPlugin('/api/v1/sse', async (app) => {
      await sseRoutes(app, {
        core,
        connectionManager,
        eventBuffer,
        commandRegistry: commandRegistry ?? undefined,
      });
    }, { auth: true });

    ctx.log.info('SSE adapter registered');
  },

  async teardown() {
    if (_adapter) {
      await _adapter.stop();
      _adapter = null;
    }
    if (_connectionManager) {
      _connectionManager.cleanup();
      _connectionManager = null;
    }
  },
};

export default plugin;
