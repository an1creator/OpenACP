import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  resolveDistribution,
  getPlatformKey,
  getBinaryPayloadKind,
  buildInstalledAgent,
} from "../agent-installer.js";
import type { RegistryAgent } from "../../types.js";

describe("agent-installer", () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  describe("getPlatformKey", () => {
    it("returns correct key for darwin arm64", () => {
      vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
      expect(getPlatformKey()).toBe("darwin-aarch64");
    });

    it("returns correct key for linux x64", () => {
      vi.stubGlobal("process", { ...process, platform: "linux", arch: "x64" });
      expect(getPlatformKey()).toBe("linux-x86_64");
    });

    it("maps both Windows registry architectures", () => {
      vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
      expect(getPlatformKey()).toBe("windows-x86_64");
      vi.stubGlobal("process", { ...process, platform: "win32", arch: "arm64" });
      expect(getPlatformKey()).toBe("windows-aarch64");
    });
  });

  describe("resolveDistribution", () => {
    it("prefers npx when available", () => {
      const agent: RegistryAgent = {
        id: "test", name: "Test", version: "1.0.0", description: "test",
        distribution: {
          npx: { package: "test@1.0.0", args: ["--acp"] },
          binary: { "darwin-aarch64": { archive: "https://example.com/test.tar.gz", cmd: "./test" } },
        },
      };
      const result = resolveDistribution(agent);
      expect(result?.type).toBe("npx");
    });

    it("falls back to binary when no npx/uvx", () => {
      vi.stubGlobal("process", { ...process, platform: "darwin", arch: "arm64" });
      const agent: RegistryAgent = {
        id: "test", name: "Test", version: "1.0.0", description: "test",
        distribution: {
          binary: { "darwin-aarch64": {
            archive: "https://example.com/test.tar.gz", cmd: "./test", sha256: "a".repeat(64),
          } },
        },
      };
      const result = resolveDistribution(agent);
      expect(result?.type).toBe("binary");
      expect(result).toMatchObject({ sha256: "a".repeat(64) });
    });

    it("returns null when no matching platform for binary", () => {
      const agent: RegistryAgent = {
        id: "test", name: "Test", version: "1.0.0", description: "test",
        distribution: {
          binary: { "windows-x86_64": { archive: "https://example.com/test.zip", cmd: "./test.exe" } },
        },
      };
      // On non-windows, this should return null
      if (process.platform !== "win32") {
        const result = resolveDistribution(agent);
        expect(result).toBeNull();
      }
    });
  });

  describe("binary payload formats", () => {
    it("recognizes every archive and raw executable format", () => {
      expect(getBinaryPayloadKind("https://example.test/a.zip?download=1")).toBe("zip");
      expect(getBinaryPayloadKind("https://example.test/a.tar.gz")).toBe("tar-gzip");
      expect(getBinaryPayloadKind("https://example.test/a.tgz#asset")).toBe("tar-gzip");
      expect(getBinaryPayloadKind("https://example.test/a.tar.bz2")).toBe("tar-bzip2");
      expect(getBinaryPayloadKind("https://example.test/a.tbz2")).toBe("tar-bzip2");
      expect(getBinaryPayloadKind("https://example.test/agent")).toBe("raw");
      expect(getBinaryPayloadKind("https://example.test/agent.exe")).toBe("raw");
    });

    it("classifies all eight Goose and siGit targets that were previously unsupported", () => {
      const snapshot = JSON.parse(fs.readFileSync(
        path.resolve(import.meta.dirname, "../../../data/registry-snapshot.json"),
        "utf8",
      )) as { agents: RegistryAgent[] };
      const targets = snapshot.agents
        .filter((agent) => agent.id === "goose" || agent.id === "sigit")
        .flatMap((agent) => Object.entries(agent.distribution.binary ?? {}).map(([platform, target]) => ({
          agent: agent.id, platform, target,
        })))
        .filter(({ target }) => {
          const kind = getBinaryPayloadKind(target.archive);
          return kind === "tar-bzip2" || kind === "raw";
        });

      expect(targets).toHaveLength(8);
      expect(targets.filter(({ agent }) => agent === "goose")).toHaveLength(4);
      expect(targets.filter(({ agent }) => agent === "sigit")).toHaveLength(4);
      expect(targets.map(({ target }) => getBinaryPayloadKind(target.archive)))
        .toEqual([
          "tar-bzip2", "tar-bzip2", "tar-bzip2", "tar-bzip2",
          "raw", "raw", "raw", "raw",
        ]);
    });
  });

  describe("buildInstalledAgent", () => {
    it("builds npx agent correctly", () => {
      const result = buildInstalledAgent(
        "claude-acp", "Claude Agent", "0.22.2",
        { type: "npx", package: "@agentclientprotocol/claude-agent-acp@0.22.2", args: [] },
      );
      expect(result.command).toBe("npx");
      expect(result.args).toEqual(["@agentclientprotocol/claude-agent-acp@0.22.2"]);
      expect(result.distribution).toBe("npx");
    });

    it("builds uvx agent correctly", () => {
      const result = buildInstalledAgent(
        "crow-cli", "crow-cli", "0.1.14",
        { type: "uvx", package: "crow-cli==0.1.14", args: ["acp"] },
      );
      expect(result.command).toBe("uvx");
      expect(result.args).toEqual(["crow-cli==0.1.14", "acp"]);
      expect(result.distribution).toBe("uvx");
    });

    it("builds binary agent with absolute path", () => {
      const result = buildInstalledAgent(
        "cursor", "Cursor", "0.1.0",
        { type: "binary", archive: "https://example.com/cursor.tar.gz", cmd: "./cursor-agent", args: ["acp"] },
        "/home/user/.openacp/agents/cursor",
      );
      expect(result.distribution).toBe("binary");
      expect(result.binaryPath).toBe("/home/user/.openacp/agents/cursor");
      expect(result.args).toEqual(["acp"]);
    });

    it("normalizes a nested Windows registry command under the binary root", () => {
      const result = buildInstalledAgent(
        "goose", "goose", "1.43.0",
        { type: "binary", archive: "https://example.com/goose.zip", cmd: ".\\goose-package\\goose.exe", args: ["acp"] },
        "/home/user/.openacp/agents/goose",
      );
      expect(result.command).toBe("/home/user/.openacp/agents/goose/goose-package/goose.exe");
    });
  });
});
