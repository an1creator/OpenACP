import {
  compare as comparePep440,
  eq as pep440Equal,
  valid as validPep440,
} from "@renovatebot/pep440";
import npa from "npm-package-arg";
import { parsePipRequirementsLine, VersionOperator } from "pip-requirements-js";
import semver from "semver";

export type RegistryRunnerType = "npx" | "uvx";
export type RunnerVersionOrder = -1 | 0 | 1 | "unknown";

/** Compare a configured runtime environment with its reviewed registry definition. */
export function environmentRecordsEqual(
  installed: Readonly<Record<string, string>> | undefined,
  reviewed: Readonly<Record<string, string>> | undefined,
): boolean {
  const installedEntries = Object.entries(installed ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const reviewedEntries = Object.entries(reviewed ?? {}).sort(([left], [right]) => left.localeCompare(right));
  return installedEntries.length === reviewedEntries.length
    && installedEntries.every(([key, value], index) => {
      const expected = reviewedEntries[index];
      return expected?.[0] === key && expected[1] === value;
    });
}

/**
 * Validate that a package-runner argument selects exactly the registry version.
 *
 * npm syntax is delegated to npm-package-arg and node-semver. Python
 * requirements are parsed as PEP 508 and their version identities are compared
 * with PEP 440 semantics. Moving selectors and environment-dependent forms are
 * deliberately rejected because OpenACP cannot truthfully record their runtime
 * version before the package manager resolves them.
 */
export function isImmutableRunnerPackageSpec(
  runner: RegistryRunnerType,
  packageSpec: string,
  registryVersion: string,
): boolean {
  if (hasUnsafeControlCharacter(packageSpec) || hasUnsafeControlCharacter(registryVersion)) {
    return false;
  }
  return runner === "npx"
    ? isExactNpmPackageSpec(packageSpec, registryVersion)
    : isExactPythonRequirement(packageSpec, registryVersion);
}

/**
 * Compare versions using the ordering of the package ecosystem that resolves
 * them. npm uses SemVer total ordering (including build identifiers for a
 * deterministic order); uv uses PEP 440 including epoch, pre/dev/post and local
 * versions. Invalid or cross-ecosystem-looking values are never guessed.
 */
export function compareRunnerVersions(
  runner: RegistryRunnerType,
  current: string,
  available: string,
): RunnerVersionOrder {
  if (hasUnsafeControlCharacter(current) || hasUnsafeControlCharacter(available)) {
    return "unknown";
  }
  if (runner === "npx") {
    const left = canonicalNpmVersion(current);
    const right = canonicalNpmVersion(available);
    if (!left || !right) return "unknown";
    return normalizeOrder(semver.compareBuild(left, right));
  }
  if (!validPep440(current) || !validPep440(available)) return "unknown";
  try {
    return normalizeOrder(comparePep440(current, available));
  } catch {
    return "unknown";
  }
}

function isExactNpmPackageSpec(packageSpec: string, registryVersion: string): boolean {
  try {
    const parsed = npa(packageSpec);
    if (parsed.type !== "version" || !parsed.registry || !parsed.name || !parsed.fetchSpec) {
      return false;
    }
    const selectedVersion = canonicalNpmVersion(parsed.fetchSpec);
    const declaredVersion = canonicalNpmVersion(registryVersion);
    return selectedVersion !== undefined
      && declaredVersion !== undefined
      && selectedVersion === declaredVersion;
  } catch {
    return false;
  }
}

function canonicalNpmVersion(value: string): string | undefined {
  try {
    const parsed = new semver.SemVer(value, { loose: false });
    const canonical = `${parsed.version}${parsed.build.length > 0 ? `+${parsed.build.join(".")}` : ""}`;
    return value === canonical ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function isExactPythonRequirement(packageSpec: string, registryVersion: string): boolean {
  if (packageSpec.includes("#")) return false;
  const uvSelector = parseExactUvToolSelector(packageSpec);
  if (uvSelector) return pythonVersionsEqual(uvSelector.version, registryVersion);
  try {
    const requirement = parsePipRequirementsLine(packageSpec);
    if (!requirement || requirement.type !== "ProjectName") return false;
    if (requirement.environmentMarkerTree) return false;
    if (requirement.extras && requirement.extras.length === 0) return false;
    if (requirement.versionSpec?.length !== 1) return false;
    const selected = requirement.versionSpec[0];
    if (selected.operator !== VersionOperator.VersionMatching || selected.version.includes("*")) {
      return false;
    }
    return pythonVersionsEqual(selected.version, registryVersion);
  } catch {
    return false;
  }
}

function parseExactUvToolSelector(value: string): { name: string; version: string } | undefined {
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)@([^@]+)$/.exec(value);
  if (!match) return undefined;
  return { name: match[1], version: match[2] };
}

function pythonVersionsEqual(selected: string, declared: string): boolean {
  return Boolean(validPep440(selected) && validPep440(declared) && pep440Equal(selected, declared));
}

function hasUnsafeControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function normalizeOrder(value: number): -1 | 0 | 1 {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}
