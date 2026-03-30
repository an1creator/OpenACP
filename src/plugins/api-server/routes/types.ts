import type { OpenACPCore } from '../../../core/core.js'
import type { TopicManager } from '../../telegram/topic-manager.js'

export interface RouteDeps {
  core: OpenACPCore
  topicManager?: TopicManager
  startedAt: number
  getVersion: () => string
}
