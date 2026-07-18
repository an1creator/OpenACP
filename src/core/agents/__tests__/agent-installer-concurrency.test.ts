import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { RegistryAgent } from "../../types.js";
import { AgentStore } from "../agent-store.js";
import { getPlatformKey, installAgent } from "../agent-installer.js";

interface WorkerHandle {
  completion: Promise<{ code: number | null; stderr: string }>;
}

function startWorker(
  scriptPath: string,
  storePath: string,
  agentsDir: string,
  version: string,
  mode: "normal" | "pause" | "crash",
  signalBase: string,
): WorkerHandle {
  const child = spawn(process.execPath, [
    "--import", "tsx", scriptPath, storePath, agentsDir, version, mode, signalBase,
  ], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const completion = new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve({ code, stderr }));
  });
  return { completion };
}

async function waitForFile(filePath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function binaryAgent(id: string, version: string): RegistryAgent {
  return {
    id,
    name: id,
    version,
    description: "concurrency fixture",
    distribution: { binary: { [getPlatformKey()]: {
      archive: `https://example.test/${id}-${version}`,
      cmd: `./${id}`,
    } } },
  };
}

describe("binary agent cross-process transactions", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  function createWorker(root: string): string {
    const scriptPath = path.join(root, "install-worker.mjs");
    const installerModule = pathToFileURL(path.resolve("src/core/agents/agent-installer.ts")).href;
    const storeModule = pathToFileURL(path.resolve("src/core/agents/agent-store.ts")).href;
    fs.writeFileSync(scriptPath, `
      import fs from "node:fs";
      import path from "node:path";
      import { syncBuiltinESMExports } from "node:module";
      const [, , storePath, agentsDir, version, mode, signalBase] = process.argv;
      const id = "race-agent";
      const originalRename = fs.renameSync.bind(fs);
      if (mode === "pause") {
        fs.renameSync = (source, destination) => {
          originalRename(source, destination);
          if (String(destination) === path.join(agentsDir, id) && String(source).endsWith(".tmp")) {
            fs.writeFileSync(signalBase + ".active", "");
            const deadline = Date.now() + 5_000;
            while (!fs.existsSync(signalBase + ".release")) {
              if (Date.now() > deadline) throw new Error("pause timed out");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
            }
          }
        };
        syncBuiltinESMExports();
      }
      const [{ AgentStore }, { getPlatformKey, installAgent }] = await Promise.all([
        import(${JSON.stringify(storeModule)}),
        import(${JSON.stringify(installerModule)}),
      ]);
      const store = new AgentStore(storePath);
      store.load();
      if (mode === "crash") store.addAgent = () => process.exit(79);
      const payload = Buffer.from("runtime-" + version);
      const registryAgent = {
        id, name: id, version, description: "worker fixture",
        distribution: { binary: { [getPlatformKey()]: {
          archive: "https://example.test/" + id + "-" + version,
          cmd: "./" + id,
        } } },
      };
      const result = await installAgent(
        registryAgent,
        store,
        undefined,
        agentsDir,
        async () => {
          fs.writeFileSync(signalBase + ".downloaded", "");
          return new Response(payload);
        },
      );
      if (!result.ok) {
        console.error(result.error);
        process.exitCode = 1;
      }
    `);
    return scriptPath;
  }

  it("keeps the final runtime and metadata from the same serialized install", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-install-process-race-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    const agentsDir = path.join(root, "agents");
    const scriptPath = createWorker(root);
    const firstSignal = path.join(root, "first");
    const secondSignal = path.join(root, "second");
    const first = startWorker(scriptPath, storePath, agentsDir, "1.0.0", "pause", firstSignal);
    await waitForFile(`${firstSignal}.active`);
    const second = startWorker(scriptPath, storePath, agentsDir, "2.0.0", "normal", secondSignal);
    await waitForFile(`${secondSignal}.downloaded`);
    let secondFinished = false;
    void second.completion.then(() => { secondFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(secondFinished).toBe(false);

    fs.writeFileSync(`${firstSignal}.release`, "");
    const [firstExit, secondExit] = await Promise.all([first.completion, second.completion]);
    expect(firstExit).toMatchObject({ code: 0 });
    expect(secondExit).toMatchObject({ code: 0 });

    const reloaded = new AgentStore(storePath);
    reloaded.load();
    expect(reloaded.getAgent("race-agent")).toMatchObject({ version: "2.0.0" });
    expect(fs.readFileSync(path.join(agentsDir, "race-agent", "race-agent"), "utf8"))
      .toBe("runtime-2.0.0");
  });

  it("recovers a dead owner after activation and before metadata commit", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-install-process-crash-"));
    roots.push(root);
    const storePath = path.join(root, "agents.json");
    const agentsDir = path.join(root, "agents");
    const destination = path.join(agentsDir, "race-agent");
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(path.join(destination, "race-agent"), "runtime-1.0.0", { mode: 0o755 });
    const store = new AgentStore(storePath);
    store.addAgent("race-agent", {
      registryId: "race-agent",
      name: "race-agent",
      version: "1.0.0",
      distribution: "binary",
      command: path.join(destination, "race-agent"),
      args: [],
      env: {},
      installedAt: "2026-07-18T00:00:00.000Z",
      binaryPath: destination,
    });
    const scriptPath = createWorker(root);
    const crashSignal = path.join(root, "crash");

    const crashed = startWorker(scriptPath, storePath, agentsDir, "2.0.0", "crash", crashSignal);
    await expect(crashed.completion).resolves.toMatchObject({ code: 79 });
    expect(fs.readFileSync(path.join(destination, "race-agent"), "utf8")).toBe("runtime-2.0.0");
    const afterCrash = new AgentStore(storePath);
    afterCrash.load();
    expect(afterCrash.getAgent("race-agent")).toMatchObject({ version: "1.0.0" });

    const result = await installAgent(
      binaryAgent("race-agent", "3.0.0"),
      afterCrash,
      undefined,
      agentsDir,
      async () => new Response(Buffer.from("runtime-3.0.0")),
    );

    expect(result).toMatchObject({ ok: true });
    expect(afterCrash.getAgent("race-agent")).toMatchObject({ version: "3.0.0" });
    expect(fs.readFileSync(path.join(destination, "race-agent"), "utf8")).toBe("runtime-3.0.0");
    expect(fs.readdirSync(agentsDir).filter((name) => (
      name.endsWith(".backup") || name.endsWith(".tmp") || name.endsWith(".cleanup")
    ))).toEqual([]);
    expect(fs.readdirSync(path.join(agentsDir, ".locks"))).toEqual([]);
  });
});
