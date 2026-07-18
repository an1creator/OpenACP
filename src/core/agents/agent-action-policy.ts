import type { AgentActionControlResponse, AgentCommand, AgentDefinition } from "../types.js";
import npa from "npm-package-arg";
import { environmentRecordsEqual } from "./agent-runner-spec.js";

/**
 * The connector-neutral action vocabulary OpenACP is willing to expose.
 * Agents still have to advertise an action before it is shown or accepted.
 */
export const STANDARD_AGENT_ACTIONS = Object.freeze([
  { name: "compact", description: "Summarize conversation to avoid hitting the context limit." },
  { name: "goal", description: "Set a goal to keep pursuing." },
  { name: "logout", description: "Sign out of the current agent account." },
  { name: "mcp", description: "List configured Model Context Protocol (MCP) tools." },
  { name: "plan", description: "Turn plan mode on." },
  { name: "review", description: "Review uncommitted changes, or review with custom instructions." },
  { name: "review-branch", description: "Review changes relative to a base branch." },
  { name: "review-commit", description: "Review a specific commit." },
  { name: "skills", description: "List available skills." },
  { name: "status", description: "Display session configuration and token usage." },
] as const);

export const MAX_ADVERTISED_COMMANDS = 4_096;
export const MAX_SKILL_NAMES = 256;
export const MAX_SKILL_NAME_LENGTH = 96;
export const MAX_LOCAL_ACTION_CHUNK_LENGTH = 4_000;
export const EMPTY_SKILLS_MESSAGE = "No skills available.";

type StandardActionName = typeof STANDARD_AGENT_ACTIONS[number]["name"];
export type SkillDiscoveryStrategy = "dollar-prefixed";

interface AgentActionProfile {
  id: string;
  actions: readonly StandardActionName[];
  descriptionOverrides?: Partial<Record<StandardActionName, string>>;
  skillDiscovery?: SkillDiscoveryStrategy;
}

const ALL_STANDARD_ACTION_NAMES = STANDARD_AGENT_ACTIONS.map(({ name }) => name);

/**
 * Profiles are deliberately centralized here. Connector code never identifies
 * agents or decides which actions are safe. The default is a vocabulary ceiling;
 * normalization still intersects it with the commands an agent actually supports.
 */
const AGENT_ACTION_PROFILES: readonly AgentActionProfile[] = [
  {
    id: "codex",
    actions: ALL_STANDARD_ACTION_NAMES,
    descriptionOverrides: {
      logout: "Sign out of Codex. This option is available when you are logged in via ChatGPT.",
    },
    skillDiscovery: "dollar-prefixed",
  },
];

const DEFAULT_ACTION_PROFILE: AgentActionProfile = {
  id: "default",
  actions: ALL_STANDARD_ACTION_NAMES,
};

export interface NormalizedAgentActionUpdate {
  commands: AgentCommand[];
  /** Safe inventory used by the local `/skills` response. Never includes descriptions or paths. */
  skillNames: string[];
  /** Present only when an agent profile defines a trustworthy inventory convention. */
  skillDiscoveryStrategy: SkillDiscoveryStrategy | null;
}

/** Fold only the ASCII action vocabulary; Unicode lookalikes are never aliases. */
export function canonicalAgentActionKey(value: string): string | null {
  const stripped = value.trim().replace(/^\/+/, "");
  if (!/^[A-Za-z0-9_-]+$/.test(stripped)) return null;
  return stripped.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function resolveActionProfile(
  agent: Partial<Pick<AgentDefinition,
    "registryId" | "distribution" | "registryPackage" | "installedVersion"
    | "registryRuntimeAttested" | "registryEnvironment" | "command" | "args" | "env">>,
): AgentActionProfile {
  // Installed registry identity is the only authority. Display names, commands,
  // paths, and runner arguments are user-controlled and must never select a profile.
  if (
    agent.registryId === "codex-acp"
    && agent.distribution === "npx"
    && agent.registryRuntimeAttested === true
    && agent.command === "npx"
    && isExactCodexInstalledPackage(agent.args?.[0], agent.installedVersion)
    && isExactCodexRegistryPackage(agent.registryPackage)
    && environmentRecordsEqual(agent.env, agent.registryEnvironment)
  ) {
    return AGENT_ACTION_PROFILES[0]!;
  }
  return DEFAULT_ACTION_PROFILE;
}

function isExactCodexInstalledPackage(
  packageSpec: string | undefined,
  installedVersion: string | undefined,
): boolean {
  if (!packageSpec || !installedVersion) return false;
  try {
    const parsed = npa(packageSpec);
    return parsed.registry === true
      && parsed.type === "version"
      && parsed.name === "@agentclientprotocol/codex-acp"
      && parsed.fetchSpec === installedVersion;
  } catch {
    return false;
  }
}

function isExactCodexRegistryPackage(packageSpec: string | undefined): boolean {
  if (!packageSpec) return false;
  try {
    const parsed = npa(packageSpec);
    return parsed.registry === true
      && parsed.type === "version"
      && parsed.name === "@agentclientprotocol/codex-acp";
  } catch {
    return false;
  }
}

function sanitizeSkillName(rawName: string): string | null {
  const trimmed = rawName.trim().slice(0, MAX_SKILL_NAME_LENGTH + 1);
  if (!trimmed || trimmed.length > MAX_SKILL_NAME_LENGTH) return null;
  // Codex plugin skills use `namespace:name`; keep that useful namespace while
  // rejecting whitespace, paths, markup, control characters, and manifest data.
  if (!/^[\p{L}\p{N}][\p{L}\p{N}._:-]*$/u.test(trimmed)) return null;
  return trimmed;
}

/** Build a bounded completed response without entering the model turn pipeline. */
export function buildSkillsControlResponse(skillNames: readonly string[]): AgentActionControlResponse {
  const safeNames = new Map<string, string>();
  for (const rawName of skillNames.slice(0, MAX_SKILL_NAMES)) {
    const safeName = typeof rawName === "string" ? sanitizeSkillName(rawName) : null;
    const key = safeName?.toLocaleLowerCase("en");
    if (safeName && key && !safeNames.has(key)) safeNames.set(key, safeName);
  }
  const lines = [...safeNames.values()].sort((left, right) => left.localeCompare(right, "en"));
  if (lines.length === 0) {
    return { type: "agent_action_control", action: "skills", status: "completed", chunks: [EMPTY_SKILLS_MESSAGE] };
  }

  const chunks: string[] = [];
  let current = "";
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_LOCAL_ACTION_CHUNK_LENGTH) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return { type: "agent_action_control", action: "skills", status: "completed", chunks };
}

function extractInput(command: Record<string, unknown>): unknown {
  const input = command.input;
  if (input == null || typeof input !== "object" || Array.isArray(input)) return undefined;
  const hint = (input as { hint?: unknown }).hint;
  if (typeof hint !== "string") return undefined;
  const normalizedHint = hint.trim().slice(0, 512);
  return normalizedHint ? { hint: normalizedHint } : undefined;
}

/**
 * Normalize one ACP `available_commands_update` at the first OpenACP boundary.
 * Descriptions and per-skill commands are discarded before they can reach a
 * session, connector, pin, middleware hook, event bus, or conversation history.
 */
export function normalizeAgentActionUpdate(
  agent: Partial<Pick<AgentDefinition,
    "registryId" | "distribution" | "registryPackage" | "installedVersion"
    | "registryRuntimeAttested" | "command" | "args">>,
  advertised: unknown,
): NormalizedAgentActionUpdate {
  const profile = resolveActionProfile(agent);
  if (!Array.isArray(advertised)) {
    return {
      commands: [],
      skillNames: [],
      skillDiscoveryStrategy: profile.skillDiscovery ?? null,
    };
  }

  const advertisedActions = new Map<string, Record<string, unknown>>();
  const skillNames = new Map<string, string>();

  for (const candidate of advertised.slice(0, MAX_ADVERTISED_COMMANDS)) {
    if (candidate == null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const command = candidate as Record<string, unknown>;
    if (typeof command.name !== "string") continue;

    const rawName = command.name.trim();
    if (rawName.startsWith("$")) {
      if (profile.skillDiscovery === "dollar-prefixed") {
        const safeName = sanitizeSkillName(rawName.slice(1));
        const dedupeKey = safeName?.toLocaleLowerCase("en");
        if (safeName && dedupeKey && !skillNames.has(dedupeKey)) skillNames.set(dedupeKey, safeName);
      }
      continue;
    }

    const actionName = canonicalAgentActionKey(command.name);
    if (actionName && !advertisedActions.has(actionName)) advertisedActions.set(actionName, command);
  }

  const allowed = new Set(profile.actions);
  const commands = STANDARD_AGENT_ACTIONS.flatMap<AgentCommand>((definition) => {
    if (!allowed.has(definition.name)) return [];
    const advertisedCommand = advertisedActions.get(definition.name);
    if (!advertisedCommand) return [];
    const handling = definition.name === "skills" && profile.skillDiscovery === "dollar-prefixed"
      ? "local-skills" as const
      : "agent" as const;
    const input = handling === "local-skills" ? undefined : extractInput(advertisedCommand);
    return [{
      name: definition.name,
      description: profile.descriptionOverrides?.[definition.name] ?? definition.description,
      input,
      action: {
        key: definition.name,
        invocation: String(advertisedCommand.name).trim(),
        handling,
        acceptsInput: handling === "agent" && input !== undefined,
      },
    }];
  });

  return {
    commands,
    skillNames: [...skillNames.values()]
      .sort((left, right) => left.localeCompare(right, "en"))
      .slice(0, MAX_SKILL_NAMES),
    skillDiscoveryStrategy: profile.skillDiscovery ?? null,
  };
}
