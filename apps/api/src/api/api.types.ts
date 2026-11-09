import type {
  AppLogEntry,
  AppLogsResponse,
  AssetRecord,
  CapabilityType,
  ConversationMetadata,
  ModelRecord,
  ProviderAdminResponse,
  ProviderAlert,
  ProviderAlertSummary,
  ProviderCheckResponse,
  ProviderHealthCheck,
  ProviderLastTest,
  ProviderModelAvailability,
  ProviderModelSummary,
  ProviderTestGenerateResponse,
  ProviderWarning,
  UserSettingsResponse,
  UserApiKeyCheckResponse,
  TaskMessage,
  TaskRecord as SharedTaskRecord,
  TaskBatchItemRecord,
  TaskBatchSummary,
} from "@yunwu/shared";

export type {
  AppLogEntry,
  AppLogsResponse,
  AssetRecord,
  CapabilityType,
  ConversationMetadata,
  ModelRecord,
  ProviderAdminResponse,
  ProviderAlert,
  ProviderAlertSummary,
  ProviderCheckResponse,
  ProviderHealthCheck,
  ProviderLastTest,
  ProviderModelAvailability,
  ProviderModelSummary,
  ProviderTestGenerateResponse,
  ProviderWarning,
  UserSettingsResponse,
  UserApiKeyCheckResponse,
  TaskMessage,
  TaskBatchItemRecord,
  TaskBatchSummary,
};

export interface ConversationSummary {
  id: string;
  title: string;
  status?: "active" | "archived" | "deleted";
  latestTaskModelId?: string;
  metadata?: ConversationMetadata;
  updatedAt: string;
  createdAt: string;
}

export interface TaskFailureRecord {
  category: string;
  retryable: boolean;
  title?: string;
  detail?: string;
  statusCode?: number;
}

export interface TaskRecord extends SharedTaskRecord {
  params?: Record<string, unknown>;
  failure?: TaskFailureRecord;
  canRetry?: boolean;
  errorMessage?: string;
  progress?: number;
  conversationId?: string;
  conversationTitle?: string;
  userId?: string;
  userEmail?: string;
  userDisplayName?: string;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
}

export interface ConversationDetail extends ConversationSummary {
  messages: TaskMessage[];
  tasks: TaskRecord[];
  assets: AssetRecord[];
}

export interface CapabilitiesResponse {
  capabilities: Array<{
    key: CapabilityType;
    name: string;
  }>;
}

export interface ModelsResponse {
  models: ModelRecord[];
}

export interface ConversationsResponse {
  conversations: ConversationSummary[];
}

export interface ConversationResponse {
  conversation: ConversationDetail;
}

export interface DeleteConversationResponse {
  conversation: ConversationSummary;
}

export interface ArchiveConversationResponse {
  conversation: ConversationSummary;
}

export interface CreateTaskResponse {
  task: TaskRecord;
  conversation: ConversationDetail;
}

export interface UploadAssetResponse {
  asset: AssetRecord;
}

export interface TaskResponse {
  task: TaskRecord;
}

export interface TasksResponse {
  tasks: TaskRecord[];
}

export interface RetryTaskResponse {
  task: TaskRecord;
  retriedFromTaskId: string;
}

export interface HistoryResponse {
  items: TaskRecord[];
}

export interface LibraryItemRecord {
  kind?: "single" | "batch";
  asset: AssetRecord;
  assets?: AssetRecord[];
  task: TaskRecord;
  conversation?: ConversationSummary;
}

export interface LibraryResponse {
  items: LibraryItemRecord[];
  /** 下一页游标；null 表示已经到最后一页。 */
  nextCursor?: string | null;
}

export interface DeleteLibraryAssetResponse {
  asset: AssetRecord;
}

export interface HomeResponse {
  recentConversations: ConversationSummary[];
  recentTasks: TaskRecord[];
  recentAssets: LibraryItemRecord[];
  recoveryTasks: TaskRecord[];
}

export interface TaskEventRecord {
  id: string;
  taskId: string;
  eventType: string;
  status?: string;
  summary: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

export interface TaskEventsResponse {
  events: TaskEventRecord[];
}

export interface ConversationTaskEventRecord {
  id: string;
  taskId: string;
  conversationId: string;
  eventType: string;
  status: string;
  title: string;
  detail: string;
  errorMessage: string | null;
  progress: number | null;
  assetIds: string[];
  createdAt: string;
  retryOfTaskId?: string;
  retryTaskId?: string;
}

export interface ConversationTaskEventsResponse {
  events: ConversationTaskEventRecord[];
}

export interface AdminModelCapabilityRecord {
  id: string;
  provider: string;
  model: string;
  modality: string;
  name: string;
  description?: string;
  capabilityTypes: CapabilityType[];
  enabled: boolean;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AdminModelCapabilitiesResponse {
  modelCapabilities: AdminModelCapabilityRecord[];
}

export type AdminLogsResponse = AppLogsResponse;

export interface AdminModelCapabilityResponse {
  modelCapability: AdminModelCapabilityRecord;
}

export interface ConversationEvent {
  type: "connected" | "task.updated" | "conversation.updated" | "heartbeat";
  conversationId: string;
  taskId?: string;
  status?: string;
  updatedAt: string;
}
