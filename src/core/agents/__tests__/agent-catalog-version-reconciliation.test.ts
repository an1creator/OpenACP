import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { InstalledAgent, RegistryAgent } from "../../types.js";
import { AgentCatalog } from "../agent-catalog.js";
import { AgentStore } from "../agent-store.js";
import { isImmutableRunnerPackageSpec } from "../agent-runner-spec.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function installedRunner(
  runner: "npx" | "uvx",
  version: string,
  packageSpec: string,
  overrides: Partial<InstalledAgent> = {},
): InstalledAgent {
  return {
    registryId: "review-agent",
    name: "Installed Review Agent",
    version,
    distribution: runner,
    command: runner,
    args: [packageSpec, "acp"],
    env: { USER_OVERRIDE: "kept" },
    installedAt: "2026-07-18T00:00:00.000Z",
    binaryPath: null,
    ...overrides,
  };
}

function registryRunner(
  runner: "npx" | "uvx",
  version: string,
  packageSpec: string,
  name = "Registry Review Agent",
): RegistryAgent {
  return {
    id: "review-agent",
    name,
    version,
    description: "Version reconciliation fixture",
    distribution: runner === "npx"
      ? { npx: { package: packageSpec, args: ["acp"], env: { REGISTRY_DEFAULT: "added" } } }
      : { uvx: { package: packageSpec, args: ["acp"], env: { REGISTRY_DEFAULT: "added" } } },
  };
}

function loadCatalog(installed: InstalledAgent, registry: RegistryAgent): {
  catalog: AgentCatalog;
  before: string;
  after: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openacp-version-reconcile-"));
  roots.push(root);
  const storePath = path.join(root, "agents.json");
  const cachePath = path.join(root, "registry-cache.json");
  fs.writeFileSync(storePath, JSON.stringify({
    version: 1,
    revision: 0,
    installed: { review: installed },
  }, null, 2));
  fs.writeFileSync(cachePath, JSON.stringify({
    fetchedAt: new Date().toISOString(),
    ttlHours: 24,
    data: { agents: [registry] },
  }));
  const before = fs.readFileSync(storePath, "utf8");
  const catalog = new AgentCatalog(new AgentStore(storePath), cachePath);
  catalog.load();
  return { catalog, before, after: fs.readFileSync(storePath, "utf8") };
}

describe("distribution-aware catalog version reconciliation", () => {
  it("does not downgrade a stable npm runner to a same-core prerelease", () => {
    const current = installedRunner("npx", "1.2.3", "review-agent@1.2.3");
    const available = registryRunner(
      "npx",
      "1.2.3-beta.1",
      "review-agent@1.2.3-beta.1",
      "Prerelease Review Agent",
    );

    const { catalog, before, after } = loadCatalog(current, available);

    expect(after).toBe(before);
    expect(catalog.getInstalledAgent("review")).toEqual(current);
    expect(catalog.getAvailable().find((item) => item.key === "review")).toMatchObject({
      version: "1.2.3",
      updateRequired: false,
    });
  });

  it.each([
    ["1.2.3-beta.1", "1.2.3"],
    ["1.2.3-beta.2", "1.2.3-beta.10"],
    ["1.2.3+build.1", "1.2.3+build.2"],
  ])("reconciles npm %s to strictly newer %s", (currentVersion, availableVersion) => {
    const { catalog } = loadCatalog(
      installedRunner("npx", currentVersion, `old-review-agent@${currentVersion}`),
      registryRunner("npx", availableVersion, `review-agent@${availableVersion}`),
    );

    const installed = catalog.getInstalledAgent("review")!;
    expect(installed).toMatchObject({
      name: "Registry Review Agent",
      version: availableVersion,
      command: "npx",
      args: [`review-agent@${availableVersion}`, "acp"],
      env: { USER_OVERRIDE: "kept", REGISTRY_DEFAULT: "added" },
    });
    expect(isImmutableRunnerPackageSpec("npx", installed.args[0]!, installed.version)).toBe(true);
  });

  it.each([
    ["1.2.3-beta.10", "1.2.3-beta.2"],
    ["1.2.3+build.2", "1.2.3+build.1"],
  ])("does not reconcile npm %s to older %s", (currentVersion, availableVersion) => {
    const current = installedRunner("npx", currentVersion, `review-agent@${currentVersion}`);
    const { catalog, before, after } = loadCatalog(
      current,
      registryRunner("npx", availableVersion, `review-agent@${availableVersion}`),
    );
    expect(after).toBe(before);
    expect(catalog.getInstalledAgent("review")).toEqual(current);
  });

  it.each([
    ["1.0rc1", "1.0"],
    ["1.0.dev2", "1.0a1"],
    ["1.0", "1.0.post1"],
    ["1.0+abc", "1.0+def"],
  ])("reconciles PEP 440 %s to strictly newer %s", (currentVersion, availableVersion) => {
    const { catalog } = loadCatalog(
      installedRunner("uvx", currentVersion, `review-agent==${currentVersion}`),
      registryRunner("uvx", availableVersion, `review-agent==${availableVersion}`),
    );
    const installed = catalog.getInstalledAgent("review")!;
    expect(installed.version).toBe(availableVersion);
    expect(installed.args[0]).toBe(`review-agent==${availableVersion}`);
    expect(isImmutableRunnerPackageSpec("uvx", installed.args[0]!, installed.version)).toBe(true);
  });

  it.each([
    ["1!1.0", "2.0"],
    ["1.0.post1", "1.0"],
    ["1.0", "1.0rc1"],
  ])("does not reconcile PEP 440 %s to older %s", (currentVersion, availableVersion) => {
    const current = installedRunner("uvx", currentVersion, `review-agent==${currentVersion}`);
    const { catalog, before, after } = loadCatalog(
      current,
      registryRunner("uvx", availableVersion, `review-agent==${availableVersion}`),
    );
    expect(after).toBe(before);
    expect(catalog.getInstalledAgent("review")).toEqual(current);
  });

  it("keeps an equal PEP 440 runner identity while enriching cosmetic metadata", () => {
    const { catalog } = loadCatalog(
      installedRunner("uvx", "1.0.0", "review-agent==1.0"),
      registryRunner("uvx", "1.0", "new-review-agent==1.0"),
    );
    expect(catalog.getInstalledAgent("review")).toMatchObject({
      name: "Registry Review Agent",
      version: "1.0.0",
      command: "uvx",
      args: ["review-agent==1.0", "acp"],
      env: { USER_OVERRIDE: "kept" },
    });
    expect(catalog.getAvailable().find((item) => item.key === "review")).toMatchObject({
      availableVersion: "1.0",
      updateRequired: true,
    });
  });

  it("does not guess for malformed legacy runner metadata and reports a diagnostic", () => {
    const current = installedRunner("npx", "legacy", "review-agent", {
      name: "Legacy Review Agent",
      command: "review",
    });
    const { catalog, before, after } = loadCatalog(
      current,
      registryRunner("npx", "2.0.0", "review-agent@2.0.0"),
    );
    expect(after).toBe(before);
    expect(catalog.getInstalledAgent("review")).toEqual(current);
    expect(catalog.getRegistryStatus()).toMatchObject({
      runnerReconciliationSkipped: 1,
      lastRunnerReconciliationWarning: expect.stringContaining("explicit installation"),
    });
  });

  it("does not mutate across runner ecosystems and reports a diagnostic", () => {
    const current = installedRunner("npx", "1.0.0", "review-agent@1.0.0");
    const { catalog, before, after } = loadCatalog(
      current,
      registryRunner("uvx", "1.1.0", "review-agent==1.1.0"),
    );
    expect(after).toBe(before);
    expect(catalog.getInstalledAgent("review")).toEqual(current);
    expect(catalog.getRegistryStatus()).toMatchObject({ runnerReconciliationSkipped: 1 });
  });
});
