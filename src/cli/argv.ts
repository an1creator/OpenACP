/**
 * Allow the documented machine-output flag to precede the command while keeping
 * command handlers simple: `openacp --json agents` becomes
 * `openacp agents --json` before dispatch.
 */
export function normalizeLeadingJsonFlag(args: readonly string[]): string[] {
  if (args[0] !== '--json' || !args[1]) return [...args]
  const rest = args.slice(2)
  const separator = rest.indexOf('--')
  if (separator === -1) return [args[1], ...rest, '--json']
  return [
    args[1],
    ...rest.slice(0, separator),
    '--json',
    ...rest.slice(separator),
  ]
}
