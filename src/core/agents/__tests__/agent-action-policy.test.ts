import { describe, expect, it } from "vitest";
import {
  MAX_LOCAL_ACTION_CHUNK_LENGTH,
  MAX_SKILL_NAMES,
  STANDARD_AGENT_ACTIONS,
  buildSkillsControlResponse,
  canonicalAgentActionKey,
  normalizeAgentActionUpdate,
} from "../agent-action-policy.js";

const codex = {
  registryId: "codex-acp",
  distribution: "npx" as const,
  registryPackage: "@agentclientprotocol/codex-acp@1.1.4",
  installedVersion: "1.1.4",
  registryRuntimeAttested: true,
  registryEnvironment: { CODEX_MODE: "reviewed" },
  command: "npx",
  args: ["@agentclientprotocol/codex-acp@1.1.4"],
  env: { CODEX_MODE: "reviewed" },
};

function advertised(name: string, extra: Record<string, unknown> = {}) {
  return { name, description: `untrusted description for ${name}`, ...extra };
}

describe("normalizeAgentActionUpdate", () => {
  it("publishes the exact ordered standard surface with canonical descriptions", () => {
    const raw = [
      advertised("status"), advertised("skills", { input: { hint: "must disappear" } }),
      advertised("review-commit"), advertised("review-branch"), advertised("review"),
      advertised("plan"), advertised("mcp"), advertised("logout"), advertised("goal"),
      advertised("compact"),
      advertised("$atcode", { description: "secret /home/user/.codex/skills/atcode/SKILL.md" }),
    ];

    const result = normalizeAgentActionUpdate(codex, raw);

    expect(result.commands).toEqual(STANDARD_AGENT_ACTIONS.map((command) => ({
      ...command,
      ...(command.name === "logout" ? {
        description: "Sign out of Codex. This option is available when you are logged in via ChatGPT.",
      } : {}),
      input: undefined,
      action: {
        key: command.name,
        invocation: command.name,
        handling: command.name === "skills" ? "local-skills" : "agent",
        acceptsInput: false,
      },
    })));
    expect(result.skillNames).toEqual(["atcode"]);
    expect(JSON.stringify(result)).not.toContain("must disappear");
    expect(JSON.stringify(result)).not.toContain("untrusted description");
    expect(JSON.stringify(result)).not.toContain("SKILL.md");
    expect(JSON.stringify(result)).not.toContain("/home/user");
  });

  it("selects the Codex profile only from trusted installed registry identity", () => {
    const spoofedDefinitions = [
      { name: "codex", command: "custom", args: [] },
      { name: "wrapper", command: "/usr/local/bin/codex-acp", args: [] },
      { name: "wrapper", command: "npx", args: ["@agentclientprotocol/codex-acp@latest"] },
      { registryId: "codex-acp", distribution: "binary" as const },
      { registryId: "codex-acp", distribution: "npx" as const },
      { registryId: "codex-acp", distribution: "npx" as const, registryPackage: "@evil/codex-acp@1.1.4" },
      { registryId: "codex-acp", distribution: "npx" as const, registryPackage: "@agentclientprotocol/codex-acp@latest" },
      {
        ...codex, command: "custom-wrapper",
      },
      {
        ...codex, args: ["@evil/codex-acp@1.1.4"],
      },
      {
        ...codex, args: ["@agentclientprotocol/codex-acp@1.1.3"],
      },
      {
        ...codex, registryRuntimeAttested: false,
      },
      ...[
        "NPM_CONFIG_REGISTRY", "npm_config_registry", "NpM_CoNfIg_ReGiStRy",
        "NODE_OPTIONS", "UV_INDEX_URL", "PYTHONPATH", "NODE_PATH", "PATH",
      ].map((key) => ({ ...codex, env: { ...codex.env, [key]: "unreviewed" } })),
      {
        ...codex, env: { CODEX_MODE: "overridden" },
      },
      {
        ...codex, registryEnvironment: {},
      },
      { registryId: "other", distribution: "npx" as const },
    ];
    for (const definition of spoofedDefinitions) {
      const result = normalizeAgentActionUpdate(definition, [
        advertised("skills"), advertised("logout"), advertised("$private"),
      ]);
      expect(result.skillDiscoveryStrategy).toBeNull();
      expect(result.skillNames).toEqual([]);
      expect(result.commands.find(({ name }) => name === "skills")?.action?.handling).toBe("agent");
      expect(result.commands.find(({ name }) => name === "logout")?.description)
        .toBe("Sign out of the current agent account.");
      expect(JSON.stringify(result)).not.toContain("unreviewed");
      expect(JSON.stringify(result)).not.toContain("NPM_CONFIG_REGISTRY");
    }

    const trusted = normalizeAgentActionUpdate(codex, [advertised("skills"), advertised("$atcode")]);
    expect(trusted.skillDiscoveryStrategy).toBe("dollar-prefixed");
    expect(trusted.skillNames).toEqual(["atcode"]);
    expect(trusted.commands[0]?.action?.handling).toBe("local-skills");
  });

  it("keeps canonical UI keys separate from the first exact advertised invocation", () => {
    const result = normalizeAgentActionUpdate(codex, [
      advertised("/ReViEw", { input: { hint: "Instructions" } }),
      advertised("REVIEW", { input: { hint: "duplicate" } }),
    ]);

    expect(result.commands).toEqual([{
      name: "review",
      description: "Review uncommitted changes, or review with custom instructions.",
      input: { hint: "Instructions" },
      action: {
        key: "review",
        invocation: "/ReViEw",
        handling: "agent",
        acceptsInput: true,
      },
    }]);
    expect(canonicalAgentActionKey(" /REVIEW ")).toBe("review");
    expect(canonicalAgentActionKey("/ＲＥＶＩＥＷ")).toBeNull();
  });

  it("uses the same centralized intersection for unrelated ACP agent identities", () => {
    const claude = normalizeAgentActionUpdate(
      { registryId: "claude", distribution: "binary" as const },
      [advertised("status"), advertised("review"), advertised("custom"), advertised("$hidden-skill")],
    );
    const gemini = normalizeAgentActionUpdate(
      { registryId: "gemini", distribution: "binary" as const },
      [advertised("compact"), advertised("mcp"), advertised("dangerous-agent-command")],
    );

    expect(claude.commands.map(({ name }) => name)).toEqual(["review", "status"]);
    expect(gemini.commands.map(({ name }) => name)).toEqual(["compact", "mcp"]);
    expect(claude.skillNames).toEqual([]);
    expect(gemini.skillNames).toEqual([]);
    expect(claude.skillDiscoveryStrategy).toBeNull();
    expect(gemini.skillDiscoveryStrategy).toBeNull();
  });

  it("sanitizes flat hints and rejects malformed, nested, path-like, and oversized entries", () => {
    const hugeName = "a".repeat(200);
    const result = normalizeAgentActionUpdate(codex, [
      null, 42, "status", {}, { name: 10 },
      advertised("/review", { input: { hint: `  ${"x".repeat(600)}  ` }, _meta: { path: "/secret" } }),
      advertised("REVIEW", { input: { hint: "duplicate" } }),
      advertised("status", { input: { hint: { nested: "secret" }, nested: "secret" } }),
      advertised("skills", { input: { hint: "ForceReply must not survive" } }),
      advertised("/$slash-prefixed-is-not-a-skill"), advertised("$atcode"), advertised("$ATCODE"),
      advertised("$../escape"), advertised("$folder/skill"), advertised("$bad skill"),
      advertised(`$${hugeName}`),
    ]);

    expect(result.commands.map(({ name }) => name)).toEqual(["review", "skills", "status"]);
    expect(result.commands[0]).toMatchObject({
      input: { hint: "x".repeat(512) },
      action: { invocation: "/review", acceptsInput: true },
    });
    expect(result.commands[1]).toMatchObject({
      input: undefined,
      action: { handling: "local-skills", acceptsInput: false },
    });
    expect(result.commands[2]).toMatchObject({ input: undefined, action: { acceptsInput: false } });
    expect(result.skillNames).toEqual(["atcode"]);
    expect(JSON.stringify(result)).not.toContain("/secret");
    expect(JSON.stringify(result)).not.toContain("nested");
    expect(JSON.stringify(result)).not.toContain("ForceReply");
    expect(normalizeAgentActionUpdate(codex, { name: "skills" })).toEqual({
      commands: [], skillNames: [], skillDiscoveryStrategy: "dollar-prefixed",
    });
  });

  it("keeps inventories and completed response chunks sorted, deduplicated, and bounded", () => {
    const raw = [advertised("skills")];
    for (let index = 4_999; index >= 0; index--) {
      raw.push(advertised(`$skill-${String(index).padStart(4, "0")}`));
    }

    const result = normalizeAgentActionUpdate(codex, raw);
    const response = buildSkillsControlResponse(result.skillNames);

    expect(result.commands.map(({ name }) => name)).toEqual(["skills"]);
    expect(result.skillNames).toHaveLength(MAX_SKILL_NAMES);
    expect(result.skillNames).toEqual([...result.skillNames].sort((a, b) => a.localeCompare(b, "en")));
    expect(new Set(result.skillNames).size).toBe(result.skillNames.length);
    expect(response).toMatchObject({ type: "agent_action_control", action: "skills", status: "completed" });
    expect(response.chunks.every((chunk) => chunk.length <= MAX_LOCAL_ACTION_CHUNK_LENGTH)).toBe(true);
    expect(response.chunks.join("\n").split("\n")).toEqual(result.skillNames);
  });

  it("does not synthesize actions for unknown agents", () => {
    const result = normalizeAgentActionUpdate(
      { registryId: "custom-agent", distribution: "binary" as const },
      [advertised("custom"), advertised("dangerous"), advertised("$private")],
    );
    expect(result).toEqual({ commands: [], skillNames: [], skillDiscoveryStrategy: null });
  });
});
