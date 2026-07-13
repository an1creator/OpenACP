import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  TokenStore,
  TokenStoreClosedError,
  TokenStorePersistenceError,
} from '../auth/token-store.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('TokenStore', () => {
  let store: TokenStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'token-store-'));
    store = new TokenStore(join(tmpDir, 'tokens.json'));
    await store.load();
  });

  afterEach(async () => {
    try {
      await store.close();
    } finally {
      vi.useRealTimers();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('creates a token with generated ID', () => {
    const token = store.create({ role: 'admin', name: 'test-token', expire: '24h' });
    expect(token.id).toMatch(/^tok_/);
    expect(token.name).toBe('test-token');
    expect(token.role).toBe('admin');
    expect(token.revoked).toBe(false);
  });

  it('refresh deadline is 7 days from creation', () => {
    const token = store.create({ role: 'admin', name: 'test', expire: '24h' });
    const created = new Date(token.createdAt).getTime();
    const deadline = new Date(token.refreshDeadline).getTime();
    expect(deadline - created).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('gets a token by ID', () => {
    const created = store.create({ role: 'viewer', name: 'get-test', expire: '1h' });
    const found = store.get(created.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(created.id);
  });

  it('returns undefined for unknown token ID', () => {
    expect(store.get('tok_nonexistent')).toBeUndefined();
  });

  it('revokes a token', () => {
    const token = store.create({ role: 'admin', name: 'revoke-test', expire: '24h' });
    store.revoke(token.id);
    expect(store.get(token.id)!.revoked).toBe(true);
  });

  it('lists all non-revoked tokens', () => {
    store.create({ role: 'admin', name: 'tok-1', expire: '24h' });
    store.create({ role: 'viewer', name: 'tok-2', expire: '24h' });
    const tok3 = store.create({ role: 'operator', name: 'tok-3', expire: '24h' });
    store.revoke(tok3.id);
    expect(store.list()).toHaveLength(2);
  });

  it('updates lastUsedAt', () => {
    const token = store.create({ role: 'admin', name: 'used-test', expire: '24h' });
    expect(token.lastUsedAt).toBeUndefined();
    store.updateLastUsed(token.id);
    expect(store.get(token.id)!.lastUsedAt).toBeDefined();
  });

  it('persists to disk and loads back', async () => {
    store.create({ role: 'admin', name: 'persist-test', expire: '24h' });
    await store.save();
    const store2 = new TokenStore(join(tmpDir, 'tokens.json'));
    await store2.load();
    expect(store2.list()).toHaveLength(1);
    expect(store2.list()[0].name).toBe('persist-test');
  });

  it('close drains an in-flight save and its coalesced revoke before cleanup', async () => {
    await store.close();
    let releaseFirstSave!: () => void;
    const firstSaveGate = new Promise<void>((resolve) => { releaseFirstSave = resolve; });
    let markFirstSaveStarted!: () => void;
    const firstSaveStarted = new Promise<void>((resolve) => { markFirstSaveStarted = resolve; });
    const writer = vi.fn(async (filePath: string, data: string, encoding: BufferEncoding) => {
      if (writer.mock.calls.length === 1) {
        markFirstSaveStarted();
        await firstSaveGate;
      }
      await writeFile(filePath, data, encoding);
    });
    store = new TokenStore(join(tmpDir, 'close-race.json'), writer);
    await store.load();

    const token = store.create({ role: 'operator', name: 'close-race', expire: '1h' });
    await firstSaveStarted;
    store.revoke(token.id);

    let secondCloseSettled = false;
    const closePromise = store.close();
    const secondClosePromise = store.close().then(() => { secondCloseSettled = true; });
    expect(store.close()).toBe(closePromise);
    await Promise.resolve();
    expect(secondCloseSettled).toBe(false);
    expect(() => store.revoke(token.id)).toThrowError(TokenStoreClosedError);
    expect(() => store.createCode({ role: 'admin', name: 'late', expire: '1h' }))
      .toThrowError(TokenStoreClosedError);

    releaseFirstSave();
    await Promise.all([closePromise, secondClosePromise]);

    expect(writer).toHaveBeenCalledTimes(2);
    const persisted = JSON.parse(await readFile(join(tmpDir, 'close-race.json'), 'utf8')) as {
      tokens: Array<{ id: string; revoked: boolean }>;
    };
    expect(persisted.tokens.find((entry) => entry.id === token.id)?.revoked).toBe(true);

    const writesAfterClose = writer.mock.calls.length;
    expect(() => store.create({ role: 'admin', name: 'closed', expire: '1h' }))
      .toThrowError(TokenStoreClosedError);
    expect(() => store.updateLastUsed(token.id)).toThrowError(TokenStoreClosedError);
    expect(() => store.revokeCode('missing')).toThrowError(TokenStoreClosedError);
    expect(() => store.cleanup()).toThrowError(TokenStoreClosedError);
    await Promise.resolve();
    expect(writer).toHaveBeenCalledTimes(writesAfterClose);
  });

  it('close clears debounced persistence without timer resurrection', async () => {
    await store.close();
    vi.useFakeTimers();
    const writer = vi.fn(async () => {});
    store = new TokenStore(join(tmpDir, 'timer.json'), writer);
    await store.load();

    const token = store.create({ role: 'viewer', name: 'timer', expire: '1h' });
    await store.flush();
    store.updateLastUsed(token.id);
    expect(vi.getTimerCount()).toBe(1);

    await store.close();
    expect(vi.getTimerCount()).toBe(0);
    const writesAfterClose = writer.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(writer).toHaveBeenCalledTimes(writesAfterClose);
  });

  it('surfaces save failures without unhandled rejection and retries while open', async () => {
    let shouldFail = true;
    const injectedError = new Error('injected disk failure');
    const writer = vi.fn(async (filePath: string, data: string, encoding: BufferEncoding) => {
      if (shouldFail) throw injectedError;
      await writeFile(filePath, data, encoding);
    });
    const failingStore = new TokenStore(join(tmpDir, 'failure.json'), writer);
    await failingStore.load();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    try {
      const token = failingStore.create({ role: 'admin', name: 'retry', expire: '1h' });
      await expect(failingStore.flush()).rejects.toBeInstanceOf(TokenStorePersistenceError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);

      shouldFail = false;
      failingStore.revoke(token.id);
      await expect(failingStore.flush()).resolves.toBeUndefined();
      const persisted = JSON.parse(await readFile(join(tmpDir, 'failure.json'), 'utf8')) as {
        tokens: Array<{ id: string; revoked: boolean }>;
      };
      expect(persisted.tokens.find((entry) => entry.id === token.id)?.revoked).toBe(true);

      shouldFail = true;
      failingStore.createCode({ role: 'admin', name: 'close-failure', expire: '1h' });
      const closePromise = failingStore.close();
      expect(failingStore.close()).toBe(closePromise);
      await expect(closePromise).rejects.toBeInstanceOf(TokenStorePersistenceError);
      await expect(failingStore.close()).rejects.toBeInstanceOf(TokenStorePersistenceError);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      expect(() => failingStore.createCode({ role: 'admin', name: 'late', expire: '1h' }))
        .toThrowError(TokenStoreClosedError);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      consoleSpy.mockRestore();
      await failingStore.close().catch(() => {});
    }
  });

  it('cleanup removes tokens past refresh deadline', () => {
    const token = store.create({ role: 'admin', name: 'expired', expire: '24h' });
    const stored = store.get(token.id)!;
    (stored as any).refreshDeadline = new Date(Date.now() - 1000).toISOString();
    store.cleanup();
    expect(store.get(token.id)).toBeUndefined();
  });
});
