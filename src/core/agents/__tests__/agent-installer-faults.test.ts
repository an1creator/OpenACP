import crypto from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RegistryAgent } from "../../types.js";
import { AgentStore } from "../agent-store.js";
import { getPlatformKey, installAgent } from "../agent-installer.js";

const faults = vi.hoisted(() => ({
  failStagingActivation: false,
  failBackupRestore: false,
  failCleanupMarkerWrite: false,
  failCommittedCleanupRemove: false,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync(source: fs.PathLike, destination: fs.PathLike): void {
      const from = String(source);
      if (faults.failStagingActivation && from.endsWith(".tmp") && !from.includes(`${path.sep}.locks${path.sep}`)) {
        throw Object.assign(new Error("activation rename failed"), { code: "EIO" });
      }
      if (faults.failBackupRestore && from.endsWith(".backup")) {
        throw Object.assign(new Error("restore rename failed"), { code: "EIO" });
      }
      actual.renameSync(source, destination);
    },
    writeFileSync(file: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions): void {
      if (faults.failCleanupMarkerWrite && String(file).endsWith(".committed")) {
        throw Object.assign(new Error("marker write failed"), { code: "EACCES" });
      }
      actual.writeFileSync(file, data, options);
    },
    rmSync(target: fs.PathLike, options?: fs.RmDirOptions): void {
      if (faults.failCommittedCleanupRemove && String(target).endsWith(".cleanup")) {
        throw Object.assign(new Error("cleanup remove failed"), { code: "EACCES" });
      }
      actual.rmSync(target, options);
    },
  };
});

describe("binary agent transaction fault recovery", () => {
  const roots: string[] = [];

  afterEach(() => {
    faults.failStagingActivation = false;
    faults.failBackupRestore = false;
    faults.failCleanupMarkerWrite = false;
    faults.failCommittedCleanupRemove = false;
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it("preserves the only previous runtime copy when activation and restoration renames both fail", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-agent-double-rename-"));
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    const installedDir = path.join(agentsDir, "rename-agent");
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, "rename-agent"), "old-runtime", { mode: 0o755 });
    const store = new AgentStore(path.join(root, "agents.json"));
    store.addAgent("rename-agent", {
      registryId: "rename-agent",
      name: "Rename agent",
      version: "1.0.0",
      distribution: "binary",
      command: path.join(installedDir, "rename-agent"),
      args: [],
      env: {},
      installedAt: "2026-07-17T00:00:00.000Z",
      binaryPath: installedDir,
    });
    const payload = Buffer.from("new-runtime");
    const agent = binaryAgent("rename-agent", "2.0.0", payload);
    faults.failStagingActivation = true;
    faults.failBackupRestore = true;

    const result = await installAgent(agent, store, undefined, agentsDir, async () => new Response(payload));

    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("recovery backup was preserved"),
    });
    expect(store.getAgent("rename-agent")).toMatchObject({ version: "1.0.0" });
    expect(fs.existsSync(installedDir)).toBe(false);
    const backups = fs.readdirSync(agentsDir).filter((name) => name.endsWith(".backup"));
    expect(backups).toHaveLength(1);
    expect(fs.readFileSync(path.join(agentsDir, backups[0]!, "rename-agent"), "utf8"))
      .toBe("old-runtime");
  });

  it("retries an unmarked committed cleanup artifact after marker creation and deletion both fail", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-agent-unmarked-cleanup-"));
    roots.push(root);
    const agentsDir = path.join(root, "agents");
    const installedDir = path.join(agentsDir, "unmarked-agent");
    fs.mkdirSync(installedDir, { recursive: true });
    fs.writeFileSync(path.join(installedDir, "unmarked-agent"), "old-runtime", { mode: 0o755 });
    const store = new AgentStore(path.join(root, "agents.json"));
    store.addAgent("unmarked-agent", {
      registryId: "unmarked-agent",
      name: "Unmarked agent",
      version: "1.0.0",
      distribution: "binary",
      command: path.join(installedDir, "unmarked-agent"),
      args: [],
      env: {},
      installedAt: "2026-07-17T00:00:00.000Z",
      binaryPath: installedDir,
    });
    const payload = Buffer.from("new-runtime");
    const agent = binaryAgent("unmarked-agent", "2.0.0", payload);
    faults.failCleanupMarkerWrite = true;
    faults.failCommittedCleanupRemove = true;

    const first = await installAgent(agent, store, undefined, agentsDir, async () => new Response(payload));

    expect(first).toMatchObject({ ok: true, cleanupPending: true, cleanupRetryable: true });
    expect(fs.readdirSync(agentsDir).filter((name) => name.endsWith(".committed"))).toEqual([]);
    expect(fs.readdirSync(agentsDir).filter((name) => name.endsWith(".cleanup"))).toHaveLength(1);

    faults.failCleanupMarkerWrite = false;
    faults.failCommittedCleanupRemove = false;
    const second = await installAgent(agent, store, undefined, agentsDir, async () => new Response(payload));

    expect(second).toMatchObject({ ok: true });
    expect(second.cleanupPending).toBeUndefined();
    expect(fs.readdirSync(agentsDir).filter((name) => name.endsWith(".cleanup"))).toEqual([]);
  });
});

function binaryAgent(id: string, version: string, payload: Buffer): RegistryAgent {
  return {
    id,
    name: id,
    version,
    description: "test",
    distribution: { binary: { [getPlatformKey()]: {
      archive: `https://example.test/${id}`,
      cmd: `./${id}`,
      sha256: crypto.createHash("sha256").update(payload).digest("hex"),
    } } },
  };
}
