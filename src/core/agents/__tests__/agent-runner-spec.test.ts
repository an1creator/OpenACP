import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { RegistryAgent } from "../../types.js";
import { buildInstalledAgent } from "../agent-installer.js";
import {
  compareRunnerVersions,
  isImmutableRunnerPackageSpec,
} from "../agent-runner-spec.js";

describe("immutable registry runner package specs", () => {
  it.each([
    ["1.2.3", "1.2.3-beta.1", 1],
    ["1.2.3-beta.1", "1.2.3", -1],
    ["1.2.3-beta.2", "1.2.3-beta.10", -1],
    ["1.2.3-beta.10", "1.2.3-beta.2", 1],
    ["1.2.3+build.1", "1.2.3+build.2", -1],
    ["1.2.3+build.2", "1.2.3+build.1", 1],
    ["1.2.3", "1.2.3", 0],
    ["v1.2.3", "1.2.3", "unknown"],
  ])("orders npm %s against %s as %s", (current, available, order) => {
    expect(compareRunnerVersions("npx", current, available)).toBe(order);
  });

  it.each([
    ["1.0rc1", "1.0", -1],
    ["1.0.dev2", "1.0a1", -1],
    ["1.0", "1.0.post1", -1],
    ["1!1.0", "2.0", 1],
    ["1.0+abc", "1.0+def", -1],
    ["1.0.0", "1.0", 0],
    ["legacy", "1.0", "unknown"],
  ])("orders PEP 440 %s against %s as %s", (current, available, order) => {
    expect(compareRunnerVersions("uvx", current, available)).toBe(order);
  });

  it.each([
    ["plain-agent@1.2.3", "1.2.3"],
    ["@scope/plain-agent@1.2.3", "1.2.3"],
    ["plain-agent@1.2.3-beta.1", "1.2.3-beta.1"],
    ["@scope/plain-agent@1.2.3-beta.1+build.4", "1.2.3-beta.1+build.4"],
  ])("accepts exact npm package %s aligned with %s", (packageSpec, version) => {
    expect(isImmutableRunnerPackageSpec("npx", packageSpec, version)).toBe(true);
  });

  it.each([
    ["plain-agent@1.2.3", "1.2.4"],
    ["plain-agent", "1.2.3"],
    ["plain-agent@latest", "1.2.3"],
    ["plain-agent@next", "1.2.3"],
    ["plain-agent@^1.2.3", "1.2.3"],
    ["plain-agent@~1.2.3", "1.2.3"],
    ["plain-agent@1.2.x", "1.2.3"],
    ["plain-agent@>=1.2.3", "1.2.3"],
    ["plain-agent@https://example.test/agent.tgz", "1.2.3"],
    ["plain-agent@git+https://example.test/agent.git", "1.2.3"],
    ["plain-agent@npm:other-agent@1.2.3", "1.2.3"],
    ["file:../plain-agent", "1.2.3"],
    ["--package=other-agent@1.2.3", "1.2.3"],
    ["plain-agent@1.2.3\n--package=other-agent", "1.2.3"],
    ["plain-agent@1.2.3;other-agent", "1.2.3"],
    ["plain-agent@1.2.3", "latest"],
    ["plain-agent@1.2.3+one", "1.2.3+two"],
  ])("rejects mutable, mismatched, or unsafe npm package %s", (packageSpec, version) => {
    expect(isImmutableRunnerPackageSpec("npx", packageSpec, version)).toBe(false);
  });

  it.each([
    ["python-agent@1.2.3", "1.2.3"],
    ["python-agent==1.2.3", "1.2.3"],
    ["python-agent[fast,security] == 1.2.3", "1.2.3"],
    ["python-agent==1.0rc1", "1.0-rc1"],
    ["python-agent==1!2.0.post1+local.1", "1!2.0.post1+local.1"],
    ["python_agent==1.0", "1.0.0"],
  ])("accepts an exact PEP 508 requirement %s aligned with %s", (packageSpec, version) => {
    expect(isImmutableRunnerPackageSpec("uvx", packageSpec, version)).toBe(true);
  });

  it.each([
    ["python-agent==1.2.3", "1.2.4"],
    ["python-agent", "1.2.3"],
    ["python-agent>=1.2.3", "1.2.3"],
    ["python-agent~=1.2.3", "1.2.3"],
    ["python-agent==1.2.*", "1.2.3"],
    ["python-agent==1.2.3,!=1.2.4", "1.2.3"],
    ["python-agent @ https://example.test/agent.whl", "1.2.3"],
    ["python-agent @ git+https://example.test/agent.git", "1.2.3"],
    ["python-agent==1.2.3; python_version >= '3.12'", "1.2.3"],
    ["python-agent==1.2.3 # moving comment", "1.2.3"],
    ["python-agent[]==1.2.3", "1.2.3"],
    ["-r requirements.txt", "1.2.3"],
    ["python-agent==1.2.3\nother-agent==9.9.9", "1.2.3"],
    ["python-agent==1.2.3; __import__('os')", "1.2.3"],
    ["python-agent==not-a-version", "not-a-version"],
  ])("rejects dynamic, mismatched, or unsafe Python requirement %s", (packageSpec, version) => {
    expect(isImmutableRunnerPackageSpec("uvx", packageSpec, version)).toBe(false);
  });

  it("defensively refuses invalid runner metadata when building the installed command", () => {
    expect(() => buildInstalledAgent(
      "moving-agent",
      "Moving agent",
      "1.0.0",
      { type: "npx", package: "moving-agent", args: [] },
    )).toThrow("must select exactly registry version 1.0.0");
    expect(() => buildInstalledAgent(
      "moving-python-agent",
      "Moving Python agent",
      "1.0.0",
      { type: "uvx", package: "moving-python-agent>=1.0.0", args: [] },
    )).toThrow("must select exactly registry version 1.0.0");
  });

  it("keeps every package-runner entry in the packaged snapshot immutable", () => {
    const snapshot = JSON.parse(fs.readFileSync(
      path.resolve(import.meta.dirname, "../../../data/registry-snapshot.json"),
      "utf8",
    )) as { agents: RegistryAgent[] };
    const runnerEntries = snapshot.agents.flatMap((agent) => [
      ...(agent.distribution.npx
        ? [{ id: agent.id, runner: "npx" as const, spec: agent.distribution.npx.package, version: agent.version }]
        : []),
      ...(agent.distribution.uvx
        ? [{ id: agent.id, runner: "uvx" as const, spec: agent.distribution.uvx.package, version: agent.version }]
        : []),
    ]);

    expect(runnerEntries.length).toBeGreaterThan(0);
    expect(runnerEntries.filter((entry) => (
      !isImmutableRunnerPackageSpec(entry.runner, entry.spec, entry.version)
    ))).toEqual([]);
  });
});
