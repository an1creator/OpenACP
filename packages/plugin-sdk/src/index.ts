// ============================================================
// @n1creator/openacp-plugin-sdk — main entry point
//
// Sub-path imports available:
//   @n1creator/openacp-plugin-sdk/formatting — format utils, icons
//   @n1creator/openacp-plugin-sdk/config     — config utils, doctor engine
//   @n1creator/openacp-plugin-sdk/testing    — test helpers, conformance tests
// ============================================================

// --- Plugin interfaces ---
export type {
  OpenACPPlugin, PluginContext, PluginPermission, PluginStorage,
  InstallContext, MigrateContext, TerminalIO, SettingsAPI,
} from '@n1creator/openacp-cli'

// --- Command types ---
export type {
  CommandDef, CommandArgs, CommandResponse, MenuOption, ListItem,
} from '@n1creator/openacp-cli'

// --- Config field types ---
export type { FieldDef } from '@n1creator/openacp-cli'

// --- Service interfaces ---
export type {
  SecurityService, FileServiceInterface, NotificationService,
  UsageService, TunnelServiceInterface, ContextService,
} from '@n1creator/openacp-cli'

export type {
  ProxyService, ProxyProtocol, ProxyRoute, ProxyProfileInput, ProxyProfile,
  ProxyStatus, ProxyRouteResolution, ProxyRouteChangeResult,
  ScopedFetch, ScopedRequestBody, ScopedRequestInit,
} from './proxy-types.js'

// --- Speech types (self-contained, no @n1creator/openacp-cli dependency) ---
export type {
  TTSProvider, TTSOptions, TTSResult,
  STTProvider, STTOptions, STTResult,
  SpeechServiceInterface,
} from './speech-types.js'

// --- Adapter types ---
export type {
  IChannelAdapter, AdapterCapabilities, OutgoingMessage, PermissionRequest,
  PermissionOption, NotificationMessage, AgentCommand,
  MessagingAdapterConfig, IRenderer, RenderedMessage,
} from '@n1creator/openacp-cli'

// --- Adapter base classes (runtime) ---
export { MessagingAdapter, StreamAdapter, BaseRenderer } from '@n1creator/openacp-cli'

// --- Adapter primitives (runtime) ---
export { SendQueue, DraftManager, ToolCallTracker, ActivityTracker } from '@n1creator/openacp-cli'
export { ToolStateMap, ThoughtBuffer } from '@n1creator/openacp-cli'
export { DisplaySpecBuilder } from '@n1creator/openacp-cli'
export { OutputModeResolver } from '@n1creator/openacp-cli'
export { ToolCardState } from '@n1creator/openacp-cli'

// --- Core types ---
export type {
  OpenACPCore, Session, SessionEvents, SessionManager, CommandRegistry,
  Attachment, PlanEntry, StopReason, SessionStatus, ConfigOption,
  UsageRecord, InstallProgress,
  DisplayVerbosity, ToolCallMeta, ToolUpdateMeta, ViewerLinks,
  TelegramPlatformData,
  TurnMeta,
} from '@n1creator/openacp-cli'

// --- Middleware types ---
export type { MiddlewarePayloadMap, MiddlewareHook } from '@n1creator/openacp-cli'

// --- New adapter primitive types ---
export type {
  ToolDisplaySpec, ThoughtDisplaySpec, ToolEntry,
  OutputMode, ToolCardSnapshot, ToolCardStateConfig,
} from '@n1creator/openacp-cli'

// --- Logging (runtime) ---
export { log, createChildLogger } from '@n1creator/openacp-cli'

// --- Data (runtime) ---
export { PRODUCT_GUIDE } from '@n1creator/openacp-cli'

// --- Sub-path re-exports (types only — use sub-path imports for values) ---
export type { ConfigFieldDef, DoctorReport, PendingFix } from './config.js'
