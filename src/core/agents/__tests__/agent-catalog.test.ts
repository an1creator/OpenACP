import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { AgentCatalog } from "../agent-catalog.js";
import { AgentStore } from "../agent-store.js";

vi.mock("node:fs");

describe("AgentCatalog", () => {
  let catalog: AgentCatalog;

  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined as any);
    const store = new AgentStore("/tmp/test/.openacp/agents.json");
    catalog = new AgentCatalog(store, "/tmp/test/.openacp/registry-cache.json");
  });

  afterEach(() => { vi.restoreAllMocks(); });

  describe("resolve", () => {
    it("returns AgentDefinition for installed agent", () => {
      const storeData = {
        version: 1,
        installed: {
          claude: {
            registryId: "claude-acp", name: "Claude Agent", version: "0.22.2",
            distribution: "npx", command: "npx",
            args: ["@agentclientprotocol/claude-agent-acp@0.22.2"],
            env: {}, installedAt: "2026-03-22T00:00:00.000Z", binaryPath: null,
          },
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(storeData) as any);
      catalog.load();

      const def = catalog.resolve("claude");
      expect(def).toBeDefined();
      expect(def!.name).toBe("claude");
      expect(def!.command).toBe("npx");
      expect(def!.args).toContain("@agentclientprotocol/claude-agent-acp@0.22.2");
    });

    it("returns undefined for unknown agent", () => {
      catalog.load();
      expect(catalog.resolve("nonexistent")).toBeUndefined();
    });

    it("migrates an installed npx agent when its registry package changes", () => {
      const storeData = {
        version: 1,
        installed: {
          codex: {
            registryId: "codex-acp", name: "Codex CLI", version: "0.10.0",
            distribution: "npx", command: "npx",
            args: ["@zed-industries/codex-acp"],
            env: { OPENACP_TEST: "preserved" },
            installedAt: "2026-03-22T00:00:00.000Z", binaryPath: null,
          },
        },
      };
      const cacheData = {
        fetchedAt: new Date().toISOString(),
        ttlHours: 24,
        data: {
          agents: [{
            id: "codex-acp", name: "Codex", version: "1.1.2",
            description: "ACP adapter for OpenAI's coding assistant",
            distribution: {
              npx: { package: "@agentclientprotocol/codex-acp@1.1.2" },
            },
          }],
        },
      };

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) => {
        return JSON.stringify(String(filePath).endsWith("agents.json") ? storeData : cacheData) as any;
      });

      catalog.load();

      expect(catalog.resolve("codex")).toMatchObject({
        command: "npx",
        args: ["@agentclientprotocol/codex-acp"],
        env: { OPENACP_TEST: "preserved" },
      });
      expect(catalog.getInstalledAgent("codex")).toMatchObject({
        name: "Codex",
        version: "1.1.2",
      });
    });
  });

  describe("getAvailable", () => {
    it("marks installed agents correctly", () => {
      const storeData = {
        version: 1,
        installed: {
          claude: {
            registryId: "claude-acp", name: "Claude Agent", version: "0.22.2",
            distribution: "npx", command: "npx", args: [], env: {},
            installedAt: "2026-03-22T00:00:00.000Z", binaryPath: null,
          },
        },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(storeData) as any);
      catalog.load();

      const items = catalog.getAvailable();
      const claudeItem = items.find((i) => i.key === "claude");
      expect(claudeItem?.installed).toBe(true);
    });
  });
});
