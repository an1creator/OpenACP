import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InstalledAgent } from "../../types.js";
import {
  AgentStore,
  AgentStoreBusyError,
} from "../agent-store.js";

function agent(name: string, version = "1.0.0"): InstalledAgent {
  return {
    registryId: `${name}-acp`,
    name,
    version,
    distribution: "custom",
    command: name,
    args: [],
    env: {},
    installedAt: "2026-07-18T00:00:00.000Z",
    binaryPath: null,
  };
}

async function runWriter(scriptPath: string, storePath: string, key: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", scriptPath, storePath, key], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`writer ${key} exited with ${String(code)}: ${stderr}`));
    });
  });
}

describe("AgentStore concurrent persistence", () => {
  const roots: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("merges add/add writes from independent loaded instances", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-agent-store-add-add-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    const first = new AgentStore(storePath);
    const second = new AgentStore(storePath);
    first.load();
    second.load();

    first.addAgent("first", agent("first"));
    second.addAgent("second", agent("second"));

    expect(first.getInstalled()).toEqual({ first: agent("first") });
    expect(second.getInstalled()).toEqual({ first: agent("first"), second: agent("second") });
    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(reloaded.getInstalled()).toEqual({ first: agent("first"), second: agent("second") });
    expect(JSON.parse(fs.readFileSync(storePath, "utf8") as string).revision).toBe(2);
  });

  it("retains an unrelated concurrent add while removing a loaded key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-agent-store-add-remove-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    const seed = new AgentStore(storePath);
    seed.addAgent("old", agent("old"));
    const adding = new AgentStore(storePath);
    const removing = new AgentStore(storePath);
    adding.load();
    removing.load();

    adding.addAgent("new", agent("new"));
    expect(removing.removeAgent("old")).toBe(true);

    expect(removing.getInstalled()).toEqual({ new: agent("new") });
    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(reloaded.getInstalled()).toEqual({ new: agent("new") });
  });

  it("merges unrelated reconciliation keys and reports same-key conflicts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-agent-store-reconcile-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    const seed = new AgentStore(storePath);
    seed.addAgent("codex", agent("codex", "1.0.0"));
    const reconciling = new AgentStore(storePath);
    const concurrent = new AgentStore(storePath);
    reconciling.load();
    concurrent.load();
    concurrent.addAgent("other", agent("other"));

    const merged = reconciling.replaceInstalled({ codex: agent("codex", "2.0.0") });
    expect(merged).toMatchObject({ appliedKeys: ["codex"], conflictKeys: [] });
    expect(reconciling.getInstalled()).toEqual({
      codex: agent("codex", "2.0.0"),
      other: agent("other"),
    });

    const staleReconciler = new AgentStore(storePath);
    const sameKeyWriter = new AgentStore(storePath);
    staleReconciler.load();
    sameKeyWriter.load();
    sameKeyWriter.addAgent("codex", agent("manual-codex", "3.0.0"));
    const conflicted = staleReconciler.replaceInstalled({
      codex: agent("registry-codex", "4.0.0"),
      other: agent("other"),
    });

    expect(conflicted).toMatchObject({ appliedKeys: [], conflictKeys: ["codex"] });
    expect(staleReconciler.getAgent("codex")).toEqual(agent("manual-codex", "3.0.0"));
    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(reloaded.getAgent("codex")).toEqual(agent("manual-codex", "3.0.0"));
  });

  it("restores truthful memory from disk when an atomic save fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-agent-store-save-failure-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    const failing = new AgentStore(storePath);
    const concurrent = new AgentStore(storePath);
    failing.load();
    concurrent.load();
    concurrent.addAgent("durable", agent("durable"));
    vi.spyOn(failing as unknown as { save(): void }, "save")
      .mockImplementationOnce(() => { throw new Error("disk full"); });

    expect(() => failing.addAgent("lost", agent("lost"))).toThrow("disk full");
    expect(failing.getInstalled()).toEqual({ durable: agent("durable") });
    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(reloaded.getInstalled()).toEqual({ durable: agent("durable") });
    expect(fs.existsSync(`${storePath}.lock`)).toBe(false);
  });

  it("quarantines a corrupt durable store before accepting a new write", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-agent-store-corrupt-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    fs.writeFileSync(storePath, "not-json");
    const store = new AgentStore(storePath);
    store.load();

    store.addAgent("recovered", agent("recovered"));

    expect(store.getInstalled()).toEqual({ recovered: agent("recovered") });
    expect(JSON.parse(fs.readFileSync(storePath, "utf8") as string).installed.recovered)
      .toMatchObject({ name: "recovered" });
    const quarantined = fs.readdirSync(root).filter((name) => name.startsWith("agents.json.corrupt-"));
    expect(quarantined).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, quarantined[0]!), "utf8")).toBe("not-json");
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(root, quarantined[0]!)).mode & 0o777).toBe(0o600);
    }
  });

  it("recovers a lock left by a crashed process and removes orphaned temp files", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-agent-store-crash-recovery-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    const store = new AgentStore(storePath);
    fs.writeFileSync(store.lockPath, JSON.stringify({ pid: 2_147_483_647, createdAt: Date.now() }));
    const orphan = path.join(root, `.agents.json-999-1-${crypto.randomUUID()}.tmp`);
    fs.writeFileSync(orphan, "partial");

    store.addAgent("recovered", agent("recovered"));

    expect(store.getAgent("recovered")).toEqual(agent("recovered"));
    expect(fs.existsSync(store.lockPath)).toBe(false);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it("fails with a bounded busy error while a live process owns the lock", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-agent-store-busy-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    const store = new AgentStore(storePath);
    fs.writeFileSync(store.lockPath, JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
    vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");

    expect(() => store.addAgent("blocked", agent("blocked"))).toThrow(AgentStoreBusyError);
    expect(Atomics.wait).toHaveBeenCalledTimes(200);
    expect(store.getInstalled()).toEqual({});
  });

  it("serializes actual writers in separate Node processes", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-agent-store-processes-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    const scriptPath = path.join(root, "writer.mjs");
    const storeModule = pathToFileURL(path.resolve("src/core/agents/agent-store.ts")).href;
    fs.writeFileSync(scriptPath, `
      import { AgentStore } from ${JSON.stringify(storeModule)};
      const [, , storePath, key] = process.argv;
      const store = new AgentStore(storePath);
      store.load();
      await new Promise((resolve) => setTimeout(resolve, 100));
      store.addAgent(key, {
        registryId: key + "-acp", name: key, version: "1.0.0",
        distribution: "custom", command: key, args: [], env: {},
        installedAt: "2026-07-18T00:00:00.000Z", binaryPath: null,
      });
    `);

    await Promise.all([
      runWriter(scriptPath, storePath, "process-a"),
      runWriter(scriptPath, storePath, "process-b"),
    ]);

    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(Object.keys(reloaded.getInstalled()).sort()).toEqual(["process-a", "process-b"]);
    expect(JSON.parse(fs.readFileSync(storePath, "utf8") as string).revision).toBe(2);
  });
});
