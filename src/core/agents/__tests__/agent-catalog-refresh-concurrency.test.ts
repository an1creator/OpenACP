import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCatalog } from "../agent-catalog.js";
import { AgentStore } from "../agent-store.js";
import type { InstalledAgent, RegistryAgent } from "../../types.js";

function registryAgent(id: string, version = "1.0.0"): RegistryAgent {
  return {
    id,
    name: id,
    version,
    description: `${id} test agent`,
    distribution: { npx: { package: `${id}@${version}` } },
  };
}

function installedAgent(registryId: string, version = "1.0.0"): InstalledAgent {
  return {
    registryId,
    name: registryId,
    version,
    distribution: "npx",
    command: "npx",
    args: [`${registryId}@${version}`],
    env: {},
    installedAt: "2026-07-18T00:00:00.000Z",
    binaryPath: null,
  };
}

function writeCache(cachePath: string, agents: RegistryAgent[], fetchedAt = "2020-01-01T00:00:00.000Z"): void {
  fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt, ttlHours: 24, data: { agents } }));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("AgentCatalog refresh concurrency and validation", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("joins background and explicit refreshes and publishes one reconciled result", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-registry-singleflight-"));
    roots.push(root);
    const cachePath = path.join(root, "registry-cache.json");
    const store = new AgentStore(path.join(root, "agents.json"));
    store.addAgent("codex", installedAgent("codex-acp"));
    writeCache(cachePath, [registryAgent("codex-acp")]);
    const pending = deferred<Response>();
    const scopedFetch = vi.fn(() => pending.promise);
    const catalog = new AgentCatalog(store, cachePath, undefined, scopedFetch as typeof fetch);
    catalog.load();
    const replaceInstalled = vi.spyOn(store, "replaceInstalled");

    const background = catalog.refreshRegistryIfStale();
    const explicit = catalog.fetchRegistry();
    pending.resolve(new Response(JSON.stringify({ agents: [registryAgent("codex-acp", "2.0.0")] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const [backgroundResult, explicitResult] = await Promise.all([background, explicit]);
    expect(scopedFetch).toHaveBeenCalledOnce();
    expect(backgroundResult).toEqual(explicitResult);
    expect(explicitResult).toMatchObject({
      ok: true,
      refreshed: true,
      count: 1,
      status: { source: "network", stale: false },
    });
    expect(replaceInstalled).toHaveBeenCalledOnce();
    expect(catalog.getInstalledAgent("codex")).toMatchObject({ version: "2.0.0" });
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8") as string).data.agents).toHaveLength(1);
  });

  it("shares a failed refresh without losing the durable catalog and permits a retry", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-registry-singleflight-failure-"));
    roots.push(root);
    const cachePath = path.join(root, "registry-cache.json");
    const old = registryAgent("stable-agent");
    writeCache(cachePath, [old]);
    const originalCache = fs.readFileSync(cachePath, "utf8");
    const pending = deferred<Response>();
    const scopedFetch = vi.fn(() => pending.promise);
    const catalog = new AgentCatalog(
      new AgentStore(path.join(root, "agents.json")),
      cachePath,
      undefined,
      scopedFetch as typeof fetch,
    );
    catalog.load();

    const background = catalog.refreshRegistryIfStale();
    const explicit = catalog.fetchRegistry();
    pending.reject(new Error("offline"));
    const [backgroundResult, explicitResult] = await Promise.all([background, explicit]);

    expect(scopedFetch).toHaveBeenCalledOnce();
    expect(backgroundResult).toEqual(explicitResult);
    expect(explicitResult).toMatchObject({
      ok: false,
      refreshed: false,
      status: { source: "cache", stale: true },
    });
    expect(catalog.getRegistryAgents()).toEqual([old]);
    expect(fs.readFileSync(cachePath, "utf8")).toBe(originalCache);

    scopedFetch.mockResolvedValueOnce(new Response(JSON.stringify({ agents: [registryAgent("new-agent")] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(catalog.fetchRegistry()).resolves.toMatchObject({ ok: true, count: 1 });
    expect(scopedFetch).toHaveBeenCalledTimes(2);
    expect(catalog.getRegistryAgents().map((agent) => agent.id)).toEqual(["new-agent"]);
  });

  it("skips invalid and duplicate entries before cache publication or enrichment", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-registry-validation-"));
    roots.push(root);
    const cachePath = path.join(root, "registry-cache.json");
    const store = new AgentStore(path.join(root, "agents.json"));
    store.addAgent("invalid", installedAgent("invalid-agent"));
    writeCache(cachePath, []);
    const valid = registryAgent("valid-agent");
    const invalid = {
      id: "invalid-agent",
      name: "Invalid",
      version: "9.0.0",
      description: "Absolute command must not be trusted",
      distribution: {
        binary: {
          "linux-x86_64": { archive: "https://example.test/agent.tar.gz", cmd: "/tmp/agent" },
        },
      },
    };
    const scopedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      agents: [valid, invalid, registryAgent("valid-agent", "2.0.0")],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const catalog = new AgentCatalog(store, cachePath, undefined, scopedFetch as typeof fetch);
    catalog.load();

    await expect(catalog.fetchRegistry()).resolves.toMatchObject({
      ok: true,
      count: 1,
      status: {
        source: "network",
        invalidEntries: 2,
        lastValidationWarning: expect.stringContaining("2 invalid or duplicate"),
      },
    });
    expect(catalog.getRegistryAgents().map((agent) => agent.id)).toEqual(["valid-agent"]);
    expect(catalog.getInstalledAgent("invalid")).toMatchObject({ version: "1.0.0" });
    const cachedIds = JSON.parse(fs.readFileSync(cachePath, "utf8") as string).data.agents
      .map((agent: RegistryAgent) => agent.id);
    expect(cachedIds).toEqual(["valid-agent"]);
  });

  it("rejects an all-invalid response without poisoning active memory or cache", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-registry-all-invalid-"));
    roots.push(root);
    const cachePath = path.join(root, "registry-cache.json");
    const stable = registryAgent("stable-agent");
    writeCache(cachePath, [stable]);
    const originalCache = fs.readFileSync(cachePath, "utf8");
    const scopedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ agents: [{
      id: "invalid-agent",
      name: "Invalid",
      version: "1.0.0",
      description: "No usable distribution",
      distribution: { npx: { args: ["--acp"] } },
    }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const catalog = new AgentCatalog(
      new AgentStore(path.join(root, "agents.json")),
      cachePath,
      undefined,
      scopedFetch as typeof fetch,
    );
    catalog.load();

    await expect(catalog.fetchRegistry()).resolves.toMatchObject({
      ok: false,
      refreshed: false,
      status: {
        source: "cache",
        stale: true,
        invalidEntries: 1,
        lastValidationWarning: expect.stringContaining("network response"),
      },
    });
    expect(catalog.getRegistryAgents()).toEqual([stable]);
    expect(fs.readFileSync(cachePath, "utf8")).toBe(originalCache);
  });

  it("filters moving and mismatched runner specs before publishing a mixed response", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-registry-runner-validation-"));
    roots.push(root);
    const cachePath = path.join(root, "registry-cache.json");
    writeCache(cachePath, []);
    const valid = registryAgent("valid-agent", "2.0.0");
    const moving = {
      ...registryAgent("moving-agent", "2.0.0"),
      distribution: { npx: { package: "moving-agent" } },
    };
    const mismatched = {
      ...registryAgent("mismatched-python-agent", "2.0.0"),
      distribution: { uvx: { package: "mismatched-python-agent==1.0.0" } },
    };
    const scopedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      agents: [moving, valid, mismatched],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const catalog = new AgentCatalog(
      new AgentStore(path.join(root, "agents.json")),
      cachePath,
      undefined,
      scopedFetch as typeof fetch,
    );
    catalog.load();

    await expect(catalog.fetchRegistry()).resolves.toMatchObject({
      ok: true,
      count: 1,
      status: { invalidEntries: 2 },
    });
    expect(catalog.getRegistryAgents()).toEqual([valid]);
    expect(JSON.parse(fs.readFileSync(cachePath, "utf8") as string).data.agents).toEqual([valid]);
  });

  it("rejects an all-moving runner response without replacing the active catalog", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-registry-runner-all-invalid-"));
    roots.push(root);
    const cachePath = path.join(root, "registry-cache.json");
    const stable = registryAgent("stable-agent");
    writeCache(cachePath, [stable]);
    const originalCache = fs.readFileSync(cachePath, "utf8");
    const scopedFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ agents: [{
      ...registryAgent("moving-agent"),
      distribution: { npx: { package: "moving-agent@latest" } },
    }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const catalog = new AgentCatalog(
      new AgentStore(path.join(root, "agents.json")),
      cachePath,
      undefined,
      scopedFetch as typeof fetch,
    );
    catalog.load();

    await expect(catalog.fetchRegistry()).resolves.toMatchObject({
      ok: false,
      status: { invalidEntries: 1 },
    });
    expect(catalog.getRegistryAgents()).toEqual([stable]);
    expect(fs.readFileSync(cachePath, "utf8")).toBe(originalCache);
  });

  it("filters a mixed durable cache while retaining an explicit diagnostic", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-registry-cache-validation-"));
    roots.push(root);
    const cachePath = path.join(root, "registry-cache.json");
    fs.writeFileSync(cachePath, JSON.stringify({
      fetchedAt: new Date().toISOString(),
      ttlHours: 24,
      data: { agents: [registryAgent("valid-agent"), {
        id: "invalid-agent",
        name: "Invalid",
        version: "1.0.0",
        description: "Insecure URL",
        distribution: { binary: {
          "linux-x86_64": { archive: "http://example.test/agent", cmd: "./agent" },
        } },
      }] },
    }));
    const catalog = new AgentCatalog(new AgentStore(path.join(root, "agents.json")), cachePath);

    catalog.load();

    expect(catalog.getRegistryAgents().map((agent) => agent.id)).toEqual(["valid-agent"]);
    expect(catalog.getRegistryStatus()).toMatchObject({
      source: "cache",
      invalidEntries: 1,
      lastValidationWarning: expect.stringContaining("cache"),
    });
  });
});
