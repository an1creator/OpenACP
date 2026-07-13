const CATEGORY_LABELS: Record<string, string> = {
  channels: 'Messaging connectors',
  agents: 'Coding agents',
  services: 'OpenACP services',
  plugins: 'Plugins',
}

const SCOPE_LABELS: Record<string, string> = {
  global: 'Default for all traffic',
  'channels.default': 'Other messaging connectors',
  'channels.telegram': 'Telegram',
  'agents.default': 'Other coding agents',
  'agents.codex': 'Codex',
  'agents.cursor': 'Cursor',
  'services.default': 'Other OpenACP services',
  'services.npmUpdate': 'OpenACP updates',
  'services.agentRegistry': 'Agent catalog',
  'services.pluginInstaller': 'Plugin installation',
  'services.speech': 'Groq transcription',
  'services.speechDownloads': 'Local speech model downloads',
  'plugins.default': 'Plugin network traffic',
}

function humanizeIdentifier(value: string): string {
  const words = value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .trim()
  return words ? `${words[0]!.toUpperCase()}${words.slice(1)}` : 'Unknown traffic'
}

export function proxyCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? humanizeIdentifier(category)
}

export function proxyScopeLabel(scope: string): string {
  if (SCOPE_LABELS[scope]) return SCOPE_LABELS[scope]
  const [category, ...rest] = scope.split('.')
  const detail = humanizeIdentifier(rest.join('.'))
  return rest.length ? `${proxyCategoryLabel(category!)} · ${detail}` : humanizeIdentifier(scope)
}

export function proxyRouteSourceLabel(scope: string): string {
  if (scope === 'global') return 'Global default'
  if (scope.endsWith('.default')) return `${proxyCategoryLabel(scope.split('.')[0]!)} default`
  return proxyScopeLabel(scope)
}
