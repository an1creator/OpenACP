import { describe, expect, it, vi } from "vitest";
import { TypedEmitter } from "../../utils/typed-emitter.js";
import type { AgentCommand, AgentEvent } from "../../types.js";
import { Session } from "../session.js";

function mockAgent(options: {
  sessionId?: string;
  commands?: AgentCommand[] | null;
  skillNames?: string[];
  inventoryReady?: boolean;
  skillDiscoveryStrategy?: "dollar-prefixed" | null;
} = {}) {
  const emitter = new TypedEmitter<{ agent_event: (event: AgentEvent) => void }>();
  return Object.assign(emitter, {
    sessionId: options.sessionId ?? "agent-session",
    agentName: "codex",
    latestCommands: options.commands ?? null,
    latestSkillNames: options.skillNames ?? [],
    skillInventoryReady: options.inventoryReady ?? false,
    skillDiscoveryStrategy: options.skillDiscoveryStrategy ?? null,
    prompt: vi.fn().mockResolvedValue({ stopReason: "end_turn" }),
    cancel: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onPermissionRequest: vi.fn(),
    onElicitationRequest: vi.fn(),
    promptCapabilities: {},
  }) as any;
}

function createSession(agent = mockAgent()) {
  const session = new Session({
    channelId: "test",
    agentName: "codex",
    workingDirectory: "/workspace",
    agentInstance: agent,
  });
  session.name = "Named session";
  return session;
}

const skillsCommand: AgentCommand = {
  name: "skills",
  description: "List available skills.",
  action: {
    key: "skills",
    invocation: "/SkIlLs",
    handling: "local-skills",
    acceptsInput: false,
  },
};

describe("Session agent action controls", () => {
  it("resolves /skills names without admitting a prompt or emitting turn events", () => {
    const agent = mockAgent({
      commands: [skillsCommand],
      skillNames: ["atcode", "figma:figma-use"],
      inventoryReady: true,
      skillDiscoveryStrategy: "dollar-prefixed",
    });
    const session = createSession(agent);
    const events: AgentEvent[] = [];
    session.on("agent_event", (event) => events.push(event));

    expect(session.resolveAgentActionControl(" /SKILLS ")).toEqual({
      type: "agent_action_control",
      action: "skills",
      status: "completed",
      chunks: ["atcode\nfigma:figma-use"],
    });
    expect(agent.prompt).not.toHaveBeenCalled();
    expect(session.promptCount).toBe(0);
    expect(session.queueDepth).toBe(0);
    expect(events).toEqual([]);
  });

  it("returns a stable completed empty result only after a trustworthy snapshot", () => {
    const readySession = createSession(mockAgent({
      commands: [skillsCommand], inventoryReady: true, skillNames: [],
      skillDiscoveryStrategy: "dollar-prefixed",
    }));
    expect(readySession.resolveAgentActionControl("skills")?.chunks).toEqual(["No skills available."]);

    const unavailableSession = createSession(mockAgent({
      commands: [skillsCommand], inventoryReady: false,
      skillDiscoveryStrategy: "dollar-prefixed",
    }));
    expect(unavailableSession.resolveAgentActionControl("skills")).toBeNull();

    const genericSession = createSession(mockAgent({
      commands: [{
        ...skillsCommand,
        action: { ...skillsCommand.action!, handling: "agent" },
      }],
      inventoryReady: true,
    }));
    expect(genericSession.resolveAgentActionControl("skills")).toBeNull();
  });

  it("keeps the ordinary Session prompt path ordinary even for /skills", async () => {
    const agent = mockAgent({
      commands: [skillsCommand], skillNames: ["atcode"], inventoryReady: true,
      skillDiscoveryStrategy: "dollar-prefixed",
    });
    const session = createSession(agent);

    await session.enqueuePrompt("/skills injected suffix");

    expect(agent.prompt).toHaveBeenCalledWith("/skills injected suffix", undefined);
    expect(session.promptCount).toBe(1);
  });

  it("does not consume resume context while resolving a local control", async () => {
    const agent = mockAgent({
      commands: [skillsCommand], skillNames: ["atcode"], inventoryReady: true,
      skillDiscoveryStrategy: "dollar-prefixed",
    });
    const session = createSession(agent);
    session.setContext("Earlier conversation");

    session.resolveAgentActionControl("skills");
    await session.enqueuePrompt("continue");

    expect(agent.prompt).toHaveBeenCalledOnce();
    expect(agent.prompt.mock.calls[0]?.[0]).toContain("Earlier conversation");
    expect(agent.prompt.mock.calls[0]?.[0]).toContain("continue");
  });

  it("hydrates snapshots, suspends them, and replaces them atomically on switch", async () => {
    const oldAgent = mockAgent({
      sessionId: "old",
      commands: [skillsCommand, { name: "review", description: "Review" }],
      skillNames: ["old-skill"],
      inventoryReady: true,
      skillDiscoveryStrategy: "dollar-prefixed",
    });
    const session = createSession(oldAgent);
    const initialEpoch = session.agentActionEpoch;
    const commandUpdates: AgentCommand[][] = [];
    session.on("agent_event", (event) => {
      if (event.type === "commands_update") commandUpdates.push(event.commands);
    });

    expect(session.latestCommands?.map(({ name }) => name)).toEqual(["skills", "review"]);
    expect(session.latestSkillNames).toEqual(["old-skill"]);
    session.suspendAgentActions();
    const suspendedEpoch = session.agentActionEpoch;
    expect(suspendedEpoch).toBeGreaterThan(initialEpoch);
    expect(session.agentActionsSuspended).toBe(true);
    expect(session.latestCommands).toEqual([]);
    expect(session.resolveAgentActionControl("skills")).toBeNull();
    oldAgent.emit("agent_event", { type: "commands_update", commands: [{ name: "status", description: "stale" }] });
    expect(session.latestCommands).toEqual([]);
    session.restoreCurrentAgentActions();
    const restoredEpoch = session.agentActionEpoch;
    expect(restoredEpoch).toBeGreaterThan(suspendedEpoch);
    expect(session.isAgentActionEpochCurrent(initialEpoch)).toBe(false);
    expect(session.isAgentActionEpochCurrent(suspendedEpoch)).toBe(false);
    expect(session.isAgentActionEpochCurrent(restoredEpoch)).toBe(true);
    expect(session.latestCommands?.map(({ name }) => name)).toEqual(["skills", "review"]);

    const newAgent = mockAgent({
      sessionId: "new",
      commands: [{ name: "status", description: "Status" }],
      skillNames: [],
      inventoryReady: true,
    });
    await session.switchAgent("gemini", async () => newAgent);

    expect(session.agentActionsSuspended).toBe(true);
    expect(session.latestCommands).toEqual([]);
    newAgent.emit("agent_event", { type: "commands_update", commands: [skillsCommand] });
    expect(session.latestCommands).toEqual([]);
    session.restoreCurrentAgentActions();

    expect(session.latestCommands?.map(({ name }) => name)).toEqual(["status"]);
    expect(session.latestSkillNames).toBeNull();
    expect(commandUpdates.at(-1)?.map(({ name }) => name)).toEqual(["status"]);

    oldAgent.emit("agent_event", { type: "commands_update", commands: [skillsCommand] });
    expect(session.latestCommands?.map(({ name }) => name)).toEqual(["status"]);
  });

  it("clears the previous snapshot when a switched agent has not advertised commands", async () => {
    const session = createSession(mockAgent({
      commands: [skillsCommand], skillNames: ["old-skill"], inventoryReady: true,
      skillDiscoveryStrategy: "dollar-prefixed",
    }));
    const commandUpdates: AgentCommand[][] = [];
    session.on("agent_event", (event) => {
      if (event.type === "commands_update") commandUpdates.push(event.commands);
    });

    await session.switchAgent("custom", async () => mockAgent({ sessionId: "new", commands: null }));
    session.restoreCurrentAgentActions();

    expect(session.latestCommands).toBeNull();
    expect(session.latestSkillNames).toBeNull();
    expect(commandUpdates.at(-1)).toEqual([]);
  });
});
