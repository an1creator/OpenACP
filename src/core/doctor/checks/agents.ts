/**
 * Doctor check: Agents — verifies configured agents are installed and
 * their commands are accessible via PATH or local node_modules/.bin.
 * Missing the default agent is a "fail"; missing optional agents are "warn".
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { DoctorCheck, CheckResult } from "../types.js";
import { AgentStore } from "../../agents/agent-store.js";
import { inspectAgentTransactions, recoverAgentTransactions } from "../../agents/agent-installer.js";

/** Checks PATH first, then walks up the directory tree looking for node_modules/.bin. */
function commandExists(cmd: string): boolean {
  try {
    execFileSync("which", [cmd], { stdio: "pipe" });
    return true;
  } catch {
    // not in PATH — fall through to node_modules check
  }
  let dir = process.cwd();
  while (true) {
    const binPath = path.join(dir, "node_modules", ".bin", cmd);
    if (fs.existsSync(binPath)) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return false;
}

export const agentsCheck: DoctorCheck = {
  name: "Agents",
  order: 2,
  async run(ctx) {
    const results: CheckResult[] = [];
    const agentsDir = path.join(ctx.dataDir, "agents");
    const transactionState = inspectAgentTransactions(agentsDir);
    if (transactionState.pending > 0) {
      results.push({
        status: "fail",
        message: `${transactionState.pending} interrupted agent transaction(s) require recovery`,
        fixable: true,
        fixRisk: "safe",
        async fix() {
          const recovery = recoverAgentTransactions(
            new AgentStore(path.join(ctx.dataDir, "agents.json")),
            agentsDir,
          );
          return {
            success: recovery.errors.length === 0 && recovery.pending === 0,
            message: recovery.errors[0]
              ?? (recovery.pending > 0
                ? `${recovery.pending} transaction cleanup operation(s) remain pending`
                : `recovered ${recovery.recovered} agent transaction(s)`),
          };
        },
      });
      // Command paths may be temporarily detached until the safe fix runs.
      // Avoid reporting derivative missing-command failures from stale state.
      return results;
    }
    if (!ctx.config) {
      results.push({ status: "fail", message: "Cannot check agents — config not loaded" });
      return results;
    }

    const defaultAgent = ctx.config.defaultAgent;

    // Read agents from agents.json (agents were migrated out of config.json)
    let agents: Record<string, { command: string }> = {};
    try {
      const agentsPath = path.join(ctx.dataDir, "agents.json");
      if (fs.existsSync(agentsPath)) {
        const data = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
        agents = data.installed ?? {};
      }
    } catch { /* proceed with empty agents */ }

    if (!agents[defaultAgent]) {
      results.push({
        status: "fail",
        message: `Default agent "${defaultAgent}" not found in agents config`,
      });
    }

    for (const [name, agent] of Object.entries(agents)) {
      const isDefault = name === defaultAgent;
      const agentEntry = agent as { command?: string };
      const agentCommand = agentEntry.command ?? name;
      if (commandExists(agentCommand)) {
        results.push({
          status: "pass",
          message: `${agentCommand} found${isDefault ? " (default)" : ""}`,
        });
      } else {
        results.push({
          status: isDefault ? "fail" : "warn",
          message: `${agentCommand} not found in PATH${isDefault ? " (default agent!)" : ""}`,
        });
      }
    }

    return results;
  },
};
