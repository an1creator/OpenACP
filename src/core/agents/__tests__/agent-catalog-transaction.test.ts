import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCatalog } from "../agent-catalog.js";
import { AgentStore } from "../agent-store.js";

describe("agent catalog persistence boundaries", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps disk and memory on the prior definition when reconciliation cannot be saved", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-catalog-transaction-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    const cachePath = path.join(root, "registry-cache.json");
    const store = new AgentStore(storePath);
    store.addAgent("codex", {
      registryId: "codex-acp",
      name: "Legacy Codex",
      version: "1.1.2",
      distribution: "npx",
      command: "npx",
      args: ["@agentclientprotocol/codex-acp@1.1.2"],
      env: { KEEP: "yes" },
      installedAt: "2026-07-17T00:00:00.000Z",
      binaryPath: null,
    });
    fs.writeFileSync(cachePath, JSON.stringify({
      fetchedAt: new Date().toISOString(),
      ttlHours: 24,
      data: { agents: [{
        id: "codex-acp",
        name: "Codex",
        version: "1.1.4",
        description: "Codex ACP",
        distribution: { npx: { package: "@agentclientprotocol/codex-acp@1.1.4" } },
      }] },
    }));
    const priorFile = fs.readFileSync(storePath, "utf8");
    const save = vi.spyOn(store as unknown as { save(): void }, "save")
      .mockImplementationOnce(() => { throw new Error("disk full"); });
    const catalog = new AgentCatalog(store, cachePath);

    expect(() => catalog.load()).not.toThrow();
    expect(catalog.getInstalledAgent("codex")).toMatchObject({
      name: "Legacy Codex",
      version: "1.1.2",
      args: ["@agentclientprotocol/codex-acp@1.1.2"],
      env: { KEEP: "yes" },
    });
    expect(fs.readFileSync(storePath, "utf8")).toBe(priorFile);
    expect(catalog.getRegistryStatus()).toMatchObject({
      source: "cache",
      reconciliationPending: true,
      lastReconciliationError: expect.stringContaining("existing definitions remain active"),
    });

    save.mockRestore();
    expect(() => catalog.load()).not.toThrow();
    expect(catalog.getInstalledAgent("codex")).toMatchObject({
      name: "Codex",
      version: "1.1.4",
      args: ["@agentclientprotocol/codex-acp@1.1.4"],
      env: { KEEP: "yes" },
    });
    expect(catalog.getRegistryStatus()).not.toHaveProperty("reconciliationPending");
  });

  it("returns detached installed-agent snapshots", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-agent-store-snapshot-"));
    roots.push(root);
    const store = new AgentStore(path.join(root, "agents.json"));
    store.addAgent("codex", {
      registryId: "codex-acp",
      name: "Codex",
      version: "1.1.4",
      distribution: "npx",
      command: "npx",
      args: ["@agentclientprotocol/codex-acp@1.1.4"],
      env: { KEEP: "yes" },
      installedAt: "2026-07-18T00:00:00.000Z",
      binaryPath: null,
    });

    const installed = store.getInstalled();
    installed.codex!.version = "mutated";
    installed.codex!.args[0] = "unreviewed@latest";
    installed.codex!.env.KEEP = "no";
    const agent = store.getAgent("codex")!;
    agent.name = "Mutated";

    expect(store.getAgent("codex")).toMatchObject({
      name: "Codex",
      version: "1.1.4",
      args: ["@agentclientprotocol/codex-acp@1.1.4"],
      env: { KEEP: "yes" },
    });
  });

  it("retains a concurrent same-agent write and marks reconciliation for retry", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-catalog-conflict-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    const cachePath = path.join(root, "registry-cache.json");
    const store = new AgentStore(storePath);
    const legacy = {
      registryId: "codex-acp",
      name: "Legacy Codex",
      version: "1.0.0",
      distribution: "npx" as const,
      command: "npx",
      args: ["codex-acp@1.0.0"],
      env: {},
      installedAt: "2026-07-18T00:00:00.000Z",
      binaryPath: null,
    };
    store.addAgent("codex", legacy);
    fs.writeFileSync(cachePath, JSON.stringify({
      fetchedAt: new Date().toISOString(),
      ttlHours: 24,
      data: { agents: [{
        id: "codex-acp",
        name: "Codex",
        version: "2.0.0",
        description: "Codex ACP",
        distribution: { npx: { package: "codex-acp@2.0.0" } },
      }] },
    }));
    const concurrent = new AgentStore(storePath);
    concurrent.load();
    const originalReplace = store.replaceInstalled.bind(store);
    vi.spyOn(store, "replaceInstalled").mockImplementationOnce((draft) => {
      concurrent.addAgent("codex", {
        ...legacy,
        name: "Manual Codex",
        version: "3.0.0",
        args: ["codex-acp@3.0.0"],
      });
      return originalReplace(draft);
    });
    const catalog = new AgentCatalog(store, cachePath);

    catalog.load();

    expect(catalog.getInstalledAgent("codex")).toMatchObject({
      name: "Manual Codex",
      version: "3.0.0",
      args: ["codex-acp@3.0.0"],
    });
    expect(catalog.getRegistryStatus()).toMatchObject({
      reconciliationPending: true,
      lastReconciliationError: expect.stringContaining("changed concurrently"),
    });
    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(reloaded.getAgent("codex")).toMatchObject({ version: "3.0.0" });
  });

  it("treats a cache timestamp from the distant future as invalid and refreshes it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-catalog-future-"));
    roots.push(root);
    const cachePath = path.join(root, "registry-cache.json");
    fs.writeFileSync(cachePath, JSON.stringify({
      fetchedAt: "2999-01-01T00:00:00.000Z",
      ttlHours: 24,
      data: { agents: [] },
    }));
    const scopedFetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ agents: [] }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const catalog = new AgentCatalog(
      new AgentStore(path.join(root, "agents.json")),
      cachePath,
      undefined,
      scopedFetch as typeof fetch,
    );

    catalog.load();
    expect(catalog.getRegistryStatus()).toMatchObject({
      source: "cache",
      stale: true,
      fetchedAt: "2999-01-01T00:00:00.000Z",
      cacheTimestampInvalid: true,
    });

    await expect(catalog.refreshRegistryIfStale()).resolves.toMatchObject({
      ok: true,
      refreshed: true,
      status: { source: "network", stale: false },
    });
    expect(scopedFetch).toHaveBeenCalledOnce();
  });

  it("keeps the active catalog aligned with the durable cache when cache publication fails", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-catalog-publication-"));
    roots.push(root);
    const cacheDir = path.join(root, "cache");
    const cachePath = path.join(cacheDir, "registry-cache.json");
    fs.mkdirSync(cacheDir);
    const oldRegistry = {
      fetchedAt: new Date().toISOString(),
      ttlHours: 24,
      data: { agents: [{
        id: "old-agent",
        name: "Old agent",
        version: "1.0.0",
        description: "durable",
        distribution: { npx: { package: "old-agent@1.0.0" } },
      }] },
    };
    fs.writeFileSync(cachePath, JSON.stringify(oldRegistry));
    const originalCache = fs.readFileSync(cachePath, "utf8");
    const scopedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      agents: [{
        id: "new-agent",
        name: "New agent",
        version: "2.0.0",
        description: "network only",
        distribution: { npx: { package: "new-agent@2.0.0" } },
      }],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const catalog = new AgentCatalog(
      new AgentStore(path.join(root, "agents.json")),
      cachePath,
      undefined,
      scopedFetch as typeof fetch,
    );
    catalog.load();
    fs.chmodSync(cacheDir, 0o500);

    let result: Awaited<ReturnType<AgentCatalog["fetchRegistry"]>>;
    try {
      result = await catalog.fetchRegistry();
    } finally {
      fs.chmodSync(cacheDir, 0o700);
    }

    expect(result).toMatchObject({
      ok: false,
      refreshed: false,
      status: { source: "cache", stale: true },
    });
    expect(catalog.getRegistryAgents().map((agent) => agent.id)).toEqual(["old-agent"]);
    expect(catalog.findRegistryAgent("new-agent")).toBeUndefined();
    expect(fs.readFileSync(cachePath, "utf8")).toBe(originalCache);
  });
});
