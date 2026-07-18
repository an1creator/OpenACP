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
            args: ["@zed-industries/codex-acp@0.10.0"],
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
            id: "codex-acp", name: "Codex", version: "1.1.4",
            description: "ACP adapter for OpenAI's coding assistant",
            distribution: {
              npx: {
                package: "@agentclientprotocol/codex-acp@1.1.4",
                env: { OPENACP_TEST: "registry", REGISTRY_DEFAULT: "added" },
              },
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
        args: ["@agentclientprotocol/codex-acp@1.1.4"],
        env: { OPENACP_TEST: "preserved", REGISTRY_DEFAULT: "added" },
        registryPackage: undefined,
        installedVersion: "1.1.4",
        registryRuntimeAttested: false,
        registryEnvironment: { OPENACP_TEST: "registry", REGISTRY_DEFAULT: "added" },
      });
      expect(catalog.getInstalledAgent("codex")).toMatchObject({
        name: "Codex",
        version: "1.1.4",
      });
    });

    it("does not attest a persisted Codex label with a mismatched runtime", () => {
      const storeData = { version: 1, installed: { codex: {
        registryId: "codex-acp", name: "Codex", version: "1.1.4",
        distribution: "npx", command: "custom-wrapper",
        args: ["@evil/codex-acp@1.1.4"], env: {},
        installedAt: "2026-07-18T00:00:00.000Z", binaryPath: null,
      } } };
      const cacheData = {
        fetchedAt: new Date().toISOString(), ttlHours: 24,
        data: { agents: [{
          id: "codex-acp", name: "Codex", version: "1.1.4", description: "Codex",
          distribution: { npx: { package: "@agentclientprotocol/codex-acp@1.1.4" } },
        }] },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) =>
        JSON.stringify(String(filePath).endsWith("agents.json") ? storeData : cacheData) as any,
      );

      catalog.load();

      expect(catalog.resolve("codex")).toMatchObject({
        command: "custom-wrapper",
        args: ["@evil/codex-acp@1.1.4"],
        registryRuntimeAttested: false,
      });
      expect(catalog.resolve("codex")?.registryPackage).toBeUndefined();
    });

    it("attests only the exact reviewed runner environment without exposing values in diagnostics", () => {
      const reviewedEnv = { CODEX_MODE: "reviewed", SAFE_FLAG: "1" };
      const storeData = { version: 1, installed: { codex: {
        registryId: "codex-acp", name: "Codex", version: "1.1.4",
        distribution: "npx", command: "npx",
        args: ["@agentclientprotocol/codex-acp@1.1.4"], env: reviewedEnv,
        installedAt: "2026-07-18T00:00:00.000Z", binaryPath: null,
      } } };
      const cacheData = {
        fetchedAt: new Date().toISOString(), ttlHours: 24,
        data: { agents: [{
          id: "codex-acp", name: "Codex", version: "1.1.4", description: "Codex",
          distribution: { npx: {
            package: "@agentclientprotocol/codex-acp@1.1.4", env: reviewedEnv,
          } },
        }] },
      };
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((filePath) =>
        JSON.stringify(String(filePath).endsWith("agents.json") ? storeData : cacheData) as any,
      );

      catalog.load();

      expect(catalog.resolve("codex")).toMatchObject({
        registryRuntimeAttested: true,
        registryEnvironment: reviewedEnv,
        env: reviewedEnv,
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

  it("uses the injected scoped transport for the ACP registry", async () => {
    const scopedFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ agents: [] }),
    })
    const store = new AgentStore("/tmp/test/.openacp/agents.json")
    const scopedCatalog = new AgentCatalog(
      store,
      "/tmp/test/.openacp/registry-cache.json",
      undefined,
      scopedFetch as typeof fetch,
    )
    await expect(scopedCatalog.fetchRegistry()).resolves.toMatchObject({ ok: true, refreshed: true })
    expect(scopedFetch).toHaveBeenCalledWith("https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json")
  })

  it("keeps a cross-distribution installed runtime until explicit installation succeeds", () => {
    const storeData = {
      version: 1,
      installed: {
        crow: {
          registryId: "crow-cli", name: "crow-cli", version: "0.1.14",
          distribution: "uvx", command: "uvx", args: ["crow-cli==0.1.14", "acp"],
          env: { USER_OVERRIDE: "kept" }, installedAt: "2026-03-22T00:00:00.000Z", binaryPath: null,
        },
      },
    };
    const cacheData = {
      fetchedAt: new Date().toISOString(), ttlHours: 24,
      data: { agents: [{
        id: "crow-cli", name: "crow-cli", version: "0.1.24", description: "Crow",
        distribution: { binary: { "linux-x86_64": {
          archive: "https://example.test/crow.tar.gz", cmd: "./crow-cli", args: ["acp"],
        } } },
      }] },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((filePath) =>
      JSON.stringify(String(filePath).endsWith("agents.json") ? storeData : cacheData) as any,
    );

    catalog.load();

    expect(catalog.getInstalledAgent("crow")).toMatchObject({
      version: "0.1.14", distribution: "uvx", command: "uvx",
      args: ["crow-cli==0.1.14", "acp"], env: { USER_OVERRIDE: "kept" },
    });
    expect(catalog.getAvailable().find((item) => item.key === "crow")).toMatchObject({
      version: "0.1.14", availableVersion: "0.1.24", updateRequired: true,
    });
  });

  it("does not relabel an existing binary when the registry publishes a newer version", () => {
    const storeData = {
      version: 1,
      installed: {
        crow: {
          registryId: "crow-cli", name: "crow-cli", version: "0.1.23",
          distribution: "binary", command: "/agents/crow-cli", args: ["acp"], env: {},
          installedAt: "2026-03-22T00:00:00.000Z", binaryPath: "/agents",
        },
      },
    };
    const cacheData = {
      fetchedAt: new Date().toISOString(), ttlHours: 24,
      data: { agents: [{
        id: "crow-cli", name: "crow-cli", version: "0.1.24", description: "Crow",
        distribution: { binary: { "linux-x86_64": {
          archive: "https://example.test/crow.tar.gz", cmd: "./crow-cli", args: ["acp"],
        } } },
      }] },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((filePath) =>
      JSON.stringify(String(filePath).endsWith("agents.json") ? storeData : cacheData) as any,
    );

    catalog.load();

    expect(catalog.getInstalledAgent("crow")).toMatchObject({
      version: "0.1.23", command: "/agents/crow-cli",
    });
    expect(catalog.getAvailable().find((item) => item.key === "crow")).toMatchObject({
      availableVersion: "0.1.24", updateRequired: true,
    });
  });

  it("does not downgrade a newer installed runner from a stale registry snapshot", () => {
    const storeData = {
      version: 1,
      installed: {
        codex: {
          registryId: "codex-acp", name: "Codex", version: "1.2.0",
          distribution: "npx", command: "npx",
          args: ["@agentclientprotocol/codex-acp@1.2.0"], env: {},
          installedAt: "2026-07-18T00:00:00.000Z", binaryPath: null,
        },
      },
    };
    const cacheData = {
      fetchedAt: "2026-01-01T00:00:00.000Z", ttlHours: 24,
      data: { agents: [{
        id: "codex-acp", name: "Codex", version: "1.1.4", description: "Codex",
        distribution: { npx: { package: "@agentclientprotocol/codex-acp@1.1.4" } },
      }] },
    };
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((filePath) =>
      JSON.stringify(String(filePath).endsWith("agents.json") ? storeData : cacheData) as any,
    );

    catalog.load();

    expect(catalog.getInstalledAgent("codex")).toMatchObject({
      version: "1.2.0", args: ["@agentclientprotocol/codex-acp@1.2.0"],
    });
    expect(catalog.getAvailable().find((item) => item.key === "codex")).toMatchObject({
      updateRequired: false,
    });
    expect(catalog.resolve("codex")).toMatchObject({
      registryRuntimeAttested: true,
      registryPackage: "@agentclientprotocol/codex-acp@1.1.4",
      installedVersion: "1.2.0",
    });
  });

  it("returns a truthful failed refresh and retains stale fallback state", async () => {
    const scopedFetch = vi.fn().mockRejectedValue(new Error("proxy credentials must not leak"));
    const store = new AgentStore("/tmp/test/.openacp/agents.json");
    const scopedCatalog = new AgentCatalog(
      store,
      "/tmp/test/.openacp/registry-cache.json",
      undefined,
      scopedFetch as typeof fetch,
    );
    scopedCatalog.load();

    const result = await scopedCatalog.fetchRegistry();

    expect(result).toMatchObject({
      ok: false,
      error: "ACP Registry could not be reached or returned invalid data",
      status: { stale: true },
    });
    expect(JSON.stringify(result)).not.toContain("proxy credentials");
  });
});
