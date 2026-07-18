import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createApiServer } from '../server.js';
import { TokenStore } from '../auth/token-store.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

describe('createApiServer', () => {
  let server: Awaited<ReturnType<typeof createApiServer>> | null = null;
  let tokenStore: TokenStore;
  let tmpDir: string;

  function serverOpts() {
    return {
      port: 0,
      host: '127.0.0.1',
      getSecret: () => 'test-secret',
      getJwtSecret: () => 'test-jwt-secret',
      tokenStore,
    };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'server-test-'));
    tokenStore = new TokenStore(path.join(tmpDir, 'tokens.json'));
    await tokenStore.load();
  });

  afterEach(async () => {
    if (server) {
      await server.app.close();
      server = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a Fastify instance with CORS and rate limiting', async () => {
    server = await createApiServer(serverOpts());
    expect(server.app).toBeDefined();
    expect(server.app.printRoutes).toBeDefined();
  });

  it('awaits token-store shutdown when the Fastify lifecycle closes', async () => {
    server = await createApiServer(serverOpts());
    const closeSpy = vi.spyOn(tokenStore, 'close');

    await server.app.close();
    server = null;

    expect(closeSpy).toHaveBeenCalledOnce();
  });

  it('surfaces token-store durability failures from the Fastify close lifecycle', async () => {
    server = await createApiServer(serverOpts());
    const durabilityError = new Error('injected durability failure');
    const closeSpy = vi.spyOn(tokenStore, 'close').mockRejectedValueOnce(durabilityError);

    await expect(server.app.close()).rejects.toBe(durabilityError);
    server = null;
    closeSpy.mockRestore();
    await tokenStore.close();
  });

  it('starts and listens on a port', async () => {
    server = await createApiServer(serverOpts());
    const address = await server.start();
    expect(address.port).toBeGreaterThan(0);
  });

  it('registers a plugin without auth and serves it', async () => {
    server = await createApiServer(serverOpts());
    server.registerPlugin('/api/v1/health', async (app) => {
      app.get('/', async () => ({ status: 'ok' }));
    }, { auth: false });
    await server.start();

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
  });

  it('returns 401 on authenticated routes without token', async () => {
    server = await createApiServer(serverOpts());
    // Register a test route with auth
    server.registerPlugin('/api/v1/test', async (app) => {
      app.get('/', async () => ({ ok: true }));
    });
    await server.start();

    const response = await server.app.inject({
      method: 'GET',
      url: '/api/v1/test',
    });

    expect(response.statusCode).toBe(401);
  });

  it.each([
    ['/api/health?probe=1', '/api/v1/system/health?probe=1'],
    ['/api/health/details', '/api/v1/system/health/details'],
    ['/api/version', '/api/v1/system/version'],
    ['/api/restart', '/api/v1/system/restart'],
    ['/api/adapters', '/api/v1/system/adapters'],
    ['/api/sessions/example', '/api/v1/sessions/example'],
  ])('redirects legacy %s to its real canonical route', async (legacy, canonical) => {
    server = await createApiServer(serverOpts());
    const response = await server.app.inject({ method: 'GET', url: legacy });

    expect(response.statusCode).toBe(308);
    expect(response.headers.location).toBe(canonical);
  });
});
