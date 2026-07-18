import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCatalog } from "../agent-catalog.js";
import { AgentStore } from "../agent-store.js";
import { agentsCheck } from "../../doctor/checks/agents.js";
import {
  getPlatformKey,
  inspectAgentTransactions,
  installAgent,
  uninstallAgent,
} from "../agent-installer.js";

type CrashMode =
  | "before-runtime-rename"
  | "after-runtime-rename"
  | "before-metadata-remove"
  | "after-metadata-remove"
  | "before-cleanup"
  | "after-cleanup"
  | "cleanup-fail"
  | "cosmetic-conflict-crash"
  | "pause-before-cas";

function seed(root: string): { storePath: string; agentsDir: string; runtimePath: string } {
  const storePath = path.join(root, "agents.json");
  const agentsDir = path.join(root, "agents");
  const runtimePath = path.join(agentsDir, "uninstall-agent");
  fs.mkdirSync(runtimePath, { recursive: true });
  fs.writeFileSync(path.join(runtimePath, "uninstall-agent"), "runtime-v1", { mode: 0o755 });
  const store = new AgentStore(storePath);
  store.addAgent("uninstall-agent", {
    registryId: "uninstall-agent",
    name: "Uninstall agent",
    version: "1.0.0",
    distribution: "binary",
    command: path.join(runtimePath, "uninstall-agent"),
    args: [],
    env: {},
    installedAt: "2026-07-18T00:00:00.000Z",
    binaryPath: runtimePath,
  });
  return { storePath, agentsDir, runtimePath };
}

function createWorker(root: string): string {
  const scriptPath = path.join(root, "uninstall-worker.mjs");
  const installerModule = pathToFileURL(path.resolve("src/core/agents/agent-installer.ts")).href;
  const storeModule = pathToFileURL(path.resolve("src/core/agents/agent-store.ts")).href;
  fs.writeFileSync(scriptPath, `
    import fs from "node:fs";
    import path from "node:path";
    import { syncBuiltinESMExports } from "node:module";
    const [, , storePath, agentsDir, mode, signalBase] = process.argv;
    const runtimePath = path.join(agentsDir, "uninstall-agent");
    const originalRename = fs.renameSync.bind(fs);
    const originalRm = fs.rmSync.bind(fs);
    fs.renameSync = (source, destination) => {
      const runtimeMove = String(source) === runtimePath && String(destination).endsWith(".uninstall");
      if (runtimeMove && mode === "before-runtime-rename") process.exit(79);
      originalRename(source, destination);
      if (runtimeMove && mode === "after-runtime-rename") process.exit(79);
    };
    fs.rmSync = (target, options) => {
      const cleanup = String(target).endsWith(".uninstall");
      if (cleanup && mode === "before-cleanup") process.exit(79);
      if (cleanup && mode === "cleanup-fail") {
        throw Object.assign(new Error("cleanup blocked"), { code: "EACCES" });
      }
      originalRm(target, options);
      if (cleanup && mode === "after-cleanup") process.exit(79);
    };
    syncBuiltinESMExports();
    const [{ AgentStore }, { uninstallAgent }] = await Promise.all([
      import(${JSON.stringify(storeModule)}),
      import(${JSON.stringify(installerModule)}),
    ]);
    const store = new AgentStore(storePath);
    store.load();
    const originalRemove = store.removeAgent.bind(store);
    if (mode === "before-metadata-remove") store.removeAgent = () => process.exit(79);
    if (mode === "after-metadata-remove") {
      store.removeAgent = (...args) => {
        const removed = originalRemove(...args);
        process.exit(79);
        return removed;
      };
    }
    if (mode === "cosmetic-conflict-crash") {
      const concurrent = new AgentStore(storePath);
      concurrent.load();
      store.removeAgent = (key, expected) => {
        concurrent.addAgent(key, { ...expected, name: "Cosmetic registry name" });
        process.exit(79);
      };
    }
    if (mode === "pause-before-cas") {
      store.removeAgent = (...args) => {
        fs.writeFileSync(signalBase + ".ready", "");
        const deadline = Date.now() + 5_000;
        while (!fs.existsSync(signalBase + ".release")) {
          if (Date.now() > deadline) throw new Error("CAS pause timed out");
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
        return originalRemove(...args);
      };
    }
    await uninstallAgent("uninstall-agent", store, agentsDir);
  `);
  return scriptPath;
}

async function runWorker(
  scriptPath: string,
  storePath: string,
  agentsDir: string,
  mode: CrashMode,
  signalBase = "",
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--import", "tsx", scriptPath, storePath, agentsDir, mode, signalBase,
    ], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("binary agent uninstall crash recovery", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  for (const mode of [
    "before-runtime-rename",
    "after-runtime-rename",
    "before-metadata-remove",
    "after-metadata-remove",
    "before-cleanup",
    "after-cleanup",
  ] as const) {
    it(`recovers a process exit ${mode}`, async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), `openacp-uninstall-${mode}-`));
      roots.push(root);
      const { storePath, agentsDir, runtimePath } = seed(root);
      const worker = createWorker(root);

      await expect(runWorker(worker, storePath, agentsDir, mode)).resolves.toMatchObject({ code: 79 });
      expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 1 });

      const catalog = new AgentCatalog(
        new AgentStore(storePath),
        path.join(root, "registry-cache.json"),
        agentsDir,
      );
      catalog.load();

      const committed = ["after-metadata-remove", "before-cleanup", "after-cleanup"].includes(mode);
      if (committed) {
        expect(catalog.getInstalledAgent("uninstall-agent")).toBeUndefined();
        expect(fs.existsSync(runtimePath)).toBe(false);
      } else {
        expect(catalog.getInstalledAgent("uninstall-agent")).toMatchObject({ version: "1.0.0" });
        expect(fs.readFileSync(path.join(runtimePath, "uninstall-agent"), "utf8")).toBe("runtime-v1");
      }
      expect(catalog.getRegistryStatus()).toMatchObject({ recoveredAgentTransactions: 1 });
      expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
      expect(fs.readdirSync(path.join(agentsDir, ".locks"))).toEqual([]);
    });
  }

  it("leaves only retryable cleanup after a committed cleanup failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-uninstall-cleanup-failure-"));
    roots.push(root);
    const { storePath, agentsDir, runtimePath } = seed(root);
    const worker = createWorker(root);

    const result = await runWorker(worker, storePath, agentsDir, "cleanup-fail");
    expect(result).toMatchObject({ code: 0 });
    const removed = new AgentStore(storePath);
    removed.load();
    expect(removed.getAgent("uninstall-agent")).toBeUndefined();
    expect(fs.existsSync(runtimePath)).toBe(false);
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 1 });

    const catalog = new AgentCatalog(removed, path.join(root, "registry-cache.json"), agentsDir);
    catalog.load();
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
    expect(catalog.getRegistryStatus()).toMatchObject({ recoveredAgentTransactions: 1 });
  });

  it("restores the runtime when cosmetic reconciliation wins the uninstall CAS", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-uninstall-cosmetic-cas-"));
    roots.push(root);
    const { storePath, agentsDir, runtimePath } = seed(root);
    const store = new AgentStore(storePath);
    const concurrent = new AgentStore(storePath);
    store.load();
    concurrent.load();
    const originalRemove = store.removeAgent.bind(store);
    store.removeAgent = (key, expected) => {
      concurrent.addAgent(key, { ...expected!, name: "Registry display name" });
      return originalRemove(key, expected);
    };

    await expect(uninstallAgent("uninstall-agent", store, agentsDir))
      .rejects.toThrow("changed while it was being uninstalled");

    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(reloaded.getAgent("uninstall-agent")).toMatchObject({
      name: "Registry display name",
      version: "1.0.0",
      installedAt: "2026-07-18T00:00:00.000Z",
    });
    expect(fs.readFileSync(path.join(runtimePath, "uninstall-agent"), "utf8")).toBe("runtime-v1");
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
  });

  it("preserves a complete replacement runtime when it wins the uninstall CAS", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-uninstall-replacement-cas-"));
    roots.push(root);
    const { storePath, agentsDir, runtimePath } = seed(root);
    const store = new AgentStore(storePath);
    const concurrent = new AgentStore(storePath);
    store.load();
    concurrent.load();
    const originalRemove = store.removeAgent.bind(store);
    store.removeAgent = (key, expected) => {
      fs.mkdirSync(runtimePath, { recursive: true });
      fs.writeFileSync(path.join(runtimePath, "uninstall-agent"), "runtime-v2", { mode: 0o755 });
      concurrent.addAgent(key, {
        ...expected!,
        name: "Replacement agent",
        version: "2.0.0",
        installedAt: "2026-07-18T01:00:00.000Z",
      });
      return originalRemove(key, expected);
    };

    await expect(uninstallAgent("uninstall-agent", store, agentsDir))
      .rejects.toThrow("changed while it was being uninstalled");

    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(reloaded.getAgent("uninstall-agent")).toMatchObject({ version: "2.0.0" });
    expect(fs.readFileSync(path.join(runtimePath, "uninstall-agent"), "utf8")).toBe("runtime-v2");
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
    expect(fs.readdirSync(agentsDir).filter((name) => name.endsWith(".uninstall"))).toEqual([]);
  });

  it("removes only the old backup when replacement metadata points elsewhere", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-uninstall-other-path-cas-"));
    roots.push(root);
    const { storePath, agentsDir } = seed(root);
    const replacementPath = path.join(agentsDir, "replacement-runtime");
    fs.mkdirSync(replacementPath, { recursive: true });
    fs.writeFileSync(path.join(replacementPath, "replacement"), "runtime-v2", { mode: 0o755 });
    const store = new AgentStore(storePath);
    const concurrent = new AgentStore(storePath);
    store.load();
    concurrent.load();
    const originalRemove = store.removeAgent.bind(store);
    store.removeAgent = (key, expected) => {
      concurrent.addAgent(key, {
        ...expected!,
        version: "2.0.0",
        command: path.join(replacementPath, "replacement"),
        binaryPath: replacementPath,
        installedAt: "2026-07-18T01:00:00.000Z",
      });
      return originalRemove(key, expected);
    };

    await expect(uninstallAgent("uninstall-agent", store, agentsDir))
      .rejects.toThrow("changed while it was being uninstalled");

    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(reloaded.getAgent("uninstall-agent")).toMatchObject({ binaryPath: replacementPath });
    expect(fs.readFileSync(path.join(replacementPath, "replacement"), "utf8")).toBe("runtime-v2");
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
  });

  it("keeps the only good backup when replacement metadata has no runtime yet", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-uninstall-ambiguous-cas-"));
    roots.push(root);
    const { storePath, agentsDir, runtimePath } = seed(root);
    const store = new AgentStore(storePath);
    const concurrent = new AgentStore(storePath);
    store.load();
    concurrent.load();
    const originalRemove = store.removeAgent.bind(store);
    store.removeAgent = (key, expected) => {
      concurrent.addAgent(key, {
        ...expected!,
        version: "2.0.0",
        installedAt: "2026-07-18T01:00:00.000Z",
      });
      return originalRemove(key, expected);
    };

    await expect(uninstallAgent("uninstall-agent", store, agentsDir))
      .rejects.toThrow("changed while it was being uninstalled");
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 1 });
    const backups = fs.readdirSync(agentsDir).filter((name) => name.endsWith(".uninstall"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(agentsDir, backups[0]!, "uninstall-agent"), "utf8"))
      .toBe("runtime-v1");

    const catalog = new AgentCatalog(store, path.join(root, "registry-cache.json"), agentsDir);
    catalog.load();
    expect(catalog.getRegistryStatus()).toMatchObject({ agentTransactionRecoveryPending: true });
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 1 });

    fs.mkdirSync(runtimePath, { recursive: true });
    fs.writeFileSync(path.join(runtimePath, "uninstall-agent"), "runtime-v2", { mode: 0o755 });
    catalog.load();
    expect(catalog.getInstalledAgent("uninstall-agent")).toMatchObject({ version: "2.0.0" });
    expect(fs.readFileSync(path.join(runtimePath, "uninstall-agent"), "utf8")).toBe("runtime-v2");
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
  });

  it("recovers a process crash after a cosmetic CAS conflict", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-uninstall-conflict-crash-"));
    roots.push(root);
    const { storePath, agentsDir, runtimePath } = seed(root);
    const worker = createWorker(root);

    await expect(runWorker(worker, storePath, agentsDir, "cosmetic-conflict-crash"))
      .resolves.toMatchObject({ code: 79 });
    const catalog = new AgentCatalog(
      new AgentStore(storePath),
      path.join(root, "registry-cache.json"),
      agentsDir,
    );
    catalog.load();

    expect(catalog.getInstalledAgent("uninstall-agent")).toMatchObject({
      name: "Cosmetic registry name",
      version: "1.0.0",
    });
    expect(fs.readFileSync(path.join(runtimePath, "uninstall-agent"), "utf8")).toBe("runtime-v1");
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
  });

  it("handles a cosmetic update from a second process before uninstall CAS", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-uninstall-two-process-cas-"));
    roots.push(root);
    const { storePath, agentsDir, runtimePath } = seed(root);
    const worker = createWorker(root);
    const signal = path.join(root, "cas");
    const uninstallCompletion = runWorker(
      worker,
      storePath,
      agentsDir,
      "pause-before-cas",
      signal,
    );
    await waitForFile(`${signal}.ready`);
    const daemonStyleWriter = new AgentStore(storePath);
    daemonStyleWriter.load();
    const current = daemonStyleWriter.getAgent("uninstall-agent")!;
    daemonStyleWriter.addAgent("uninstall-agent", { ...current, name: "Daemon registry name" });
    fs.writeFileSync(`${signal}.release`, "");

    await expect(uninstallCompletion).resolves.toMatchObject({ code: 1 });
    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(reloaded.getAgent("uninstall-agent")).toMatchObject({ name: "Daemon registry name" });
    expect(fs.readFileSync(path.join(runtimePath, "uninstall-agent"), "utf8")).toBe("runtime-v1");
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
  });

  it("recovers an interrupted uninstall before activating a competing install", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-uninstall-then-install-"));
    roots.push(root);
    const { storePath, agentsDir, runtimePath } = seed(root);
    const worker = createWorker(root);
    await expect(runWorker(worker, storePath, agentsDir, "after-runtime-rename"))
      .resolves.toMatchObject({ code: 79 });
    const store = new AgentStore(storePath);
    store.load();

    const result = await installAgent({
      id: "uninstall-agent",
      name: "Uninstall agent",
      version: "2.0.0",
      description: "replacement",
      distribution: { binary: { [getPlatformKey()]: {
        archive: "https://example.test/uninstall-agent-v2",
        cmd: "./uninstall-agent",
      } } },
    }, store, undefined, agentsDir, async () => new Response(Buffer.from("runtime-v2")));

    expect(result).toMatchObject({ ok: true });
    expect(store.getAgent("uninstall-agent")).toMatchObject({ version: "2.0.0" });
    expect(fs.readFileSync(path.join(runtimePath, "uninstall-agent"), "utf8")).toBe("runtime-v2");
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
    expect(fs.readdirSync(path.join(agentsDir, ".locks"))).toEqual([]);
  });

  it("finds a committed journal after metadata is gone and recovers idempotently", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-uninstall-idempotent-"));
    roots.push(root);
    const { storePath, agentsDir, runtimePath } = seed(root);
    const worker = createWorker(root);
    await expect(runWorker(worker, storePath, agentsDir, "after-metadata-remove"))
      .resolves.toMatchObject({ code: 79 });
    const store = new AgentStore(storePath);

    await expect(uninstallAgent("uninstall-agent", store, agentsDir)).resolves.toBeUndefined();
    await expect(uninstallAgent("uninstall-agent", store, agentsDir)).resolves.toBeUndefined();

    expect(store.getAgent("uninstall-agent")).toBeUndefined();
    expect(fs.existsSync(runtimePath)).toBe(false);
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
  });

  it("exposes interrupted uninstall recovery as a safe Doctor repair", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-uninstall-doctor-"));
    roots.push(root);
    const { storePath, agentsDir, runtimePath } = seed(root);
    const worker = createWorker(root);
    await expect(runWorker(worker, storePath, agentsDir, "after-runtime-rename"))
      .resolves.toMatchObject({ code: 79 });

    const results = await agentsCheck.run({
      config: { defaultAgent: "uninstall-agent" } as never,
      rawConfig: {},
      configPath: path.join(root, "config.json"),
      dataDir: root,
      sessionsPath: path.join(root, "sessions.json"),
      pidPath: path.join(root, "openacp.pid"),
      portFilePath: path.join(root, "api.port"),
      pluginsDir: path.join(root, "plugins"),
      logsDir: path.join(root, "logs"),
      fetchForScope: () => fetch,
    });
    const recovery = results.find((result) => result.message.includes("interrupted agent transaction"));

    expect(recovery).toMatchObject({ status: "fail", fixable: true, fixRisk: "safe" });
    await expect(recovery!.fix!()).resolves.toMatchObject({ success: true });
    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(reloaded.getAgent("uninstall-agent")).toMatchObject({ version: "1.0.0" });
    expect(fs.readFileSync(path.join(runtimePath, "uninstall-agent"), "utf8")).toBe("runtime-v1");
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
  });

  it("removes runtime and metadata together on a normal uninstall", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-uninstall-normal-"));
    roots.push(root);
    const { storePath, agentsDir, runtimePath } = seed(root);
    const store = new AgentStore(storePath);
    store.load();

    await uninstallAgent("uninstall-agent", store, agentsDir);

    expect(store.getAgent("uninstall-agent")).toBeUndefined();
    expect(fs.existsSync(runtimePath)).toBe(false);
    expect(inspectAgentTransactions(agentsDir)).toEqual({ pending: 0 });
    expect(fs.readdirSync(path.join(agentsDir, ".locks"))).toEqual([]);
  });
});
