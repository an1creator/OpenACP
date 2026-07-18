import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistryAgent } from "../../types.js";
import { AgentCatalog } from "../agent-catalog.js";
import { AgentStore } from "../agent-store.js";
import { getPlatformKey } from "../agent-installer.js";

function binaryAgent(version: string): RegistryAgent {
  return {
    id: "catalog-race-agent",
    name: "Catalog race agent",
    version,
    description: "catalog transaction fixture",
    distribution: {
      binary: {
        [getPlatformKey()]: {
          archive: `https://downloads.example.test/catalog-race-agent-${version}`,
          cmd: "./catalog-race-agent",
        },
      },
    },
  };
}

function writeRegistry(cachePath: string, agent: RegistryAgent): void {
  fs.writeFileSync(cachePath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    ttlHours: 24,
    data: { agents: [agent] },
  }));
}

function createCatalog(
  root: string,
  cacheName: string,
  agent: RegistryAgent,
  scopedFetch: typeof fetch,
): AgentCatalog {
  const cachePath = path.join(root, cacheName);
  writeRegistry(cachePath, agent);
  const catalog = new AgentCatalog(
    new AgentStore(path.join(root, "agents.json")),
    cachePath,
    path.join(root, "agents"),
    scopedFetch,
    "https://registry.example.test/agents.json",
  );
  catalog.load();
  return catalog;
}

describe("agent catalog install serialization", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("does not let a stale v1 catalog downgrade a v2 install that wins during its download", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-catalog-install-race-"));
    roots.push(root);
    let releaseOldDownload!: () => void;
    const oldDownloadReleased = new Promise<void>((resolve) => { releaseOldDownload = resolve; });
    let oldDownloadStarted!: () => void;
    const oldDownloadReady = new Promise<void>((resolve) => { oldDownloadStarted = resolve; });
    const oldFetch = vi.fn(async () => {
      oldDownloadStarted();
      await oldDownloadReleased;
      return new Response(Buffer.from("runtime-v1"));
    });
    const newFetch = vi.fn(async () => new Response(Buffer.from("runtime-v2")));
    const oldCatalog = createCatalog(root, "registry-v1.json", binaryAgent("1.0.0"), oldFetch);
    const newCatalog = createCatalog(root, "registry-v2.json", binaryAgent("2.0.0"), newFetch);

    const oldInstall = oldCatalog.install("catalog-race-agent");
    await oldDownloadReady;
    await expect(newCatalog.install("catalog-race-agent")).resolves.toMatchObject({ ok: true });
    releaseOldDownload();

    await expect(oldInstall).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("Use --force to replace it with v1.0.0"),
    });
    const reloaded = new AgentStore(path.join(root, "agents.json"));
    reloaded.load();
    expect(reloaded.getAgent("catalog-race-agent")).toMatchObject({ version: "2.0.0" });
    expect(fs.readFileSync(
      path.join(root, "agents", "catalog-race-agent", "catalog-race-agent"),
      "utf8",
    )).toBe("runtime-v2");
    expect(oldFetch).toHaveBeenCalledOnce();
    expect(newFetch).toHaveBeenCalledOnce();
  });

  it("treats a concurrent install of the same registry version as an idempotent no-op", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-catalog-install-idempotent-"));
    roots.push(root);
    const firstCatalog = createCatalog(
      root,
      "registry-first.json",
      binaryAgent("2.0.0"),
      async () => new Response(Buffer.from("runtime-first")),
    );
    const secondFetch = vi.fn(async () => new Response(Buffer.from("runtime-second")));
    const staleCatalog = createCatalog(
      root,
      "registry-stale.json",
      binaryAgent("2.0.0"),
      secondFetch,
    );

    await expect(firstCatalog.install("catalog-race-agent")).resolves.toMatchObject({ ok: true });
    const storePath = path.join(root, "agents.json");
    const beforeStore = fs.readFileSync(storePath, "utf8");
    const beforeRuntime = fs.readFileSync(
      path.join(root, "agents", "catalog-race-agent", "catalog-race-agent"),
      "utf8",
    );

    await expect(staleCatalog.install("catalog-race-agent")).resolves.toMatchObject({
      ok: true,
      alreadyInstalled: true,
    });
    expect(fs.readFileSync(storePath, "utf8")).toBe(beforeStore);
    expect(fs.readFileSync(
      path.join(root, "agents", "catalog-race-agent", "catalog-race-agent"),
      "utf8",
    )).toBe(beforeRuntime);
    expect(secondFetch).toHaveBeenCalledOnce();
    expect(fs.readdirSync(path.join(root, "agents")).filter((name) => name.includes(".tmp")))
      .toEqual([]);
  });

  it("allows an explicit force install to replace a version installed by another catalog", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-catalog-install-force-"));
    roots.push(root);
    const oldCatalog = createCatalog(
      root,
      "registry-v1.json",
      binaryAgent("1.0.0"),
      async () => new Response(Buffer.from("runtime-v1")),
    );
    const newCatalog = createCatalog(
      root,
      "registry-v2.json",
      binaryAgent("2.0.0"),
      async () => new Response(Buffer.from("runtime-v2")),
    );

    await expect(newCatalog.install("catalog-race-agent")).resolves.toMatchObject({ ok: true });
    await expect(oldCatalog.install("catalog-race-agent", undefined, true)).resolves.toMatchObject({
      ok: true,
    });

    const reloaded = new AgentStore(path.join(root, "agents.json"));
    reloaded.load();
    expect(reloaded.getAgent("catalog-race-agent")).toMatchObject({ version: "1.0.0" });
    expect(fs.readFileSync(
      path.join(root, "agents", "catalog-race-agent", "catalog-race-agent"),
      "utf8",
    )).toBe("runtime-v1");
  });

  it("does not trust an in-memory same-version entry after another catalog replaces it", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-catalog-install-stale-memory-"));
    roots.push(root);
    const oldCatalog = createCatalog(
      root,
      "registry-v1.json",
      binaryAgent("1.0.0"),
      async () => new Response(Buffer.from("runtime-v1")),
    );
    await expect(oldCatalog.install("catalog-race-agent")).resolves.toMatchObject({ ok: true });
    const newCatalog = createCatalog(
      root,
      "registry-v2.json",
      binaryAgent("2.0.0"),
      async () => new Response(Buffer.from("runtime-v2")),
    );
    await expect(newCatalog.install("catalog-race-agent", undefined, true)).resolves.toMatchObject({
      ok: true,
    });

    await expect(oldCatalog.install("catalog-race-agent")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("already installed as v2.0.0"),
    });
    const reloaded = new AgentStore(path.join(root, "agents.json"));
    reloaded.load();
    expect(reloaded.getAgent("catalog-race-agent")).toMatchObject({ version: "2.0.0" });
    expect(fs.readFileSync(
      path.join(root, "agents", "catalog-race-agent", "catalog-race-agent"),
      "utf8",
    )).toBe("runtime-v2");
  });

  it("uses the refreshed registry version and still requires force for a real replacement", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-catalog-install-refresh-"));
    roots.push(root);
    const v1 = binaryAgent("1.0.0");
    const v2 = binaryAgent("2.0.0");
    const registryUrl = "https://registry.example.test/agents.json";
    const scopedFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === registryUrl) {
        return new Response(JSON.stringify({ agents: [v2] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(Buffer.from(url.endsWith("2.0.0") ? "runtime-v2" : "runtime-v1"));
    });
    const cachePath = path.join(root, "registry.json");
    writeRegistry(cachePath, v1);
    const catalog = new AgentCatalog(
      new AgentStore(path.join(root, "agents.json")),
      cachePath,
      path.join(root, "agents"),
      scopedFetch as typeof fetch,
      registryUrl,
    );
    catalog.load();

    await expect(catalog.install("catalog-race-agent")).resolves.toMatchObject({ ok: true });
    await expect(catalog.fetchRegistry()).resolves.toMatchObject({
      ok: true,
      refreshed: true,
      status: { source: "network" },
    });
    await expect(catalog.install("catalog-race-agent")).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("replace it with v2.0.0"),
    });
    await expect(catalog.install("catalog-race-agent", undefined, true)).resolves.toMatchObject({ ok: true });

    expect(catalog.getInstalledAgent("catalog-race-agent")).toMatchObject({ version: "2.0.0" });
    expect(fs.readFileSync(
      path.join(root, "agents", "catalog-race-agent", "catalog-race-agent"),
      "utf8",
    )).toBe("runtime-v2");
  });
});
