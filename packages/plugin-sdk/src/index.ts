// Plugin interfaces
export type {
  OpenACPPlugin, PluginContext, PluginPermission, PluginStorage,
  InstallContext, MigrateContext, TerminalIO, SettingsAPI,
} from '@openacp/cli'

// Command types
export type {
  CommandDef, CommandArgs, CommandResponse, MenuOption, ListItem,
} from '@openacp/cli'

// Service interfaces
export type {
  SecurityService, FileServiceInterface, NotificationService,
  UsageService, SpeechServiceInterface, TunnelServiceInterface, ContextService,
} from '@openacp/cli'

// Adapter types
export type {
  IChannelAdapter, OutgoingMessage, PermissionRequest,
  PermissionOption, NotificationMessage, AgentCommand,
} from '@openacp/cli'

// Core types
export type {
  Attachment, PlanEntry, InstallProgress,
  DisplayVerbosity, ToolCallMeta, ToolUpdateMeta, ViewerLinks,
  AdapterCapabilities, IRenderer, MessagingAdapterConfig, RenderedMessage,
} from '@openacp/cli'

// Core classes & values
export { OpenACPCore } from '@openacp/cli'
export { Session } from '@openacp/cli'
export { SessionManager } from '@openacp/cli'
export { CommandRegistry } from '@openacp/cli'
export { log, createChildLogger } from '@openacp/cli'
export { PRODUCT_GUIDE } from '@openacp/cli'

// Adapter base classes
export { MessagingAdapter, StreamAdapter, BaseRenderer } from '@openacp/cli'

// Adapter primitives
export { SendQueue, DraftManager, ToolCallTracker, ActivityTracker } from '@openacp/cli'
