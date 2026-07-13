const pluginLifecycleTails = new Map<string, Promise<void>>()

/** Serialize runtime lifecycle and registry changes for one plugin in one process. */
export async function withPluginLifecycleMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = pluginLifecycleTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const tail = previous.then(() => gate)
  pluginLifecycleTails.set(key, tail)
  await previous
  try { return await operation() }
  finally {
    release()
    if (pluginLifecycleTails.get(key) === tail) pluginLifecycleTails.delete(key)
  }
}
