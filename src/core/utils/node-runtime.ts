/** Lowest Node.js major supported by the OpenACP runtime and bundled ACP agents. */
export const MINIMUM_NODE_MAJOR = 22

/** Node.js major installed by OpenACP's automated installers. */
export const DEFAULT_NODE_MAJOR = 24

export interface NodeRuntimeSupport {
  version: string
  major: number | null
  supported: boolean
}

/** Evaluate a Node.js version string against the product runtime boundary. */
export function evaluateNodeRuntime(version = process.versions.node): NodeRuntimeSupport {
  const match = /^(\d+)(?:\.|$)/.exec(version.trim())
  const major = match ? Number(match[1]) : null
  return {
    version,
    major,
    supported: major !== null && major >= MINIMUM_NODE_MAJOR,
  }
}

/** Human-readable setup/diagnostic message for the current Node.js runtime. */
export function nodeRuntimeMessage(version = process.versions.node): string {
  const support = evaluateNodeRuntime(version)
  if (support.supported) return `Node.js ${support.version} meets the required version (${MINIMUM_NODE_MAJOR} or newer)`
  return `Node.js ${support.version || 'unknown'} is unsupported; install Node.js ${MINIMUM_NODE_MAJOR} or newer (Node.js ${DEFAULT_NODE_MAJOR} is recommended)`
}
