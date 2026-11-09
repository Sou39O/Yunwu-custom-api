import type {
  AssetRecord,
  CapabilityType,
  ConversationMetadata,
  ModelRecord,
  TaskMessage,
  TaskRecord as SharedTaskRecord,
  TaskBatchItemRecord,
  TaskBatchSummary,
  TaskSourceAction,
  TaskStatus,
} from "@yunwu/shared";

export type ApiTaskFailure = {
  category: string;
  retryable: boolean;
  title?: string;
  detail?: string;
  statusCode?: number;
};

export type ConversationSummary = {
  id: string;
  title: string;
  metadata?: ConversationMetadata;
  summary?: string;
  status?: "idle" | "running" | "done";
  model?: string;
  createdAt?: string;
  updatedAt: string;
};

export type TaskRecord = SharedTaskRecord & {
  params?: Record<string, unknown>;
  failure?: ApiTaskFailure;
  canRetry?: boolean;
  progress?: number;
  conversationId?: string;
  conversationTitle?: string;
  userId?: string;
  userEmail?: string;
  userDisplayName?: string;
  inputSummary?: Record<string, unknown>;
  outputSummary?: Record<string, unknown>;
};

export type ApiTask = TaskRecord;

export type ConversationDetail = ConversationSummary & {
  messages: TaskMessage[];
  tasks: TaskRecord[];
  assets: AssetRecord[];
};

export type CreateConversationInput = {
  title?: string;
};

export type CreateTaskInput = {
  conversationId?: string;
  capability: CapabilityType;
  model: string;
  prompt: string;
  assetIds?: string[];
  params?: Record<string, unknown>;
  sourceTaskId?: string;
  sourceAction?: TaskSourceAction;
  fork?: boolean;
  batchCount?: number;
};

export type CreateTaskResponse = {
  task: TaskRecord;
  conversation: ConversationDetail;
};

export type RetryTaskResponse = {
  task: TaskRecord;
  retriedFromTaskId: string;
};

export type UploadAssetResponse = {
  asset: AssetRecord;
};

export type LibraryItemRecord = {
  kind?: "single" | "batch";
  asset: AssetRecord;
  assets?: AssetRecord[];
  task: TaskRecord;
  conversation?: ConversationSummary;
};

export type HomeResponse = {
  recentConversations: ConversationSummary[];
  recentTasks: TaskRecord[];
  recentAssets: LibraryItemRecord[];
  recoveryTasks: TaskRecord[];
};

export type HistoryResponse = {
  items: TaskRecord[];
};

export type LibraryResponse = {
  items: LibraryItemRecord[];
  /** 下一页游标；null 表示已经到最后一页。 */
  nextCursor?: string | null;
};

export type DeleteLibraryAssetResponse = {
  asset: AssetRecord;
};

export type ConversationMutationResponse = {
  conversation?: ConversationSummary;
};

export type ApiKeyStatus = {
  configured: boolean;
  masked?: string | null;
  lastVerifiedAt?: string | null;
};

export type ApiKeyMutationResponse = {
  apiKey?: ApiKeyStatus;
  providerApiKey?: {
    configured?: boolean;
    maskedApiKey?: string | null;
  };
  check?: {
    baseUrlReachable?: boolean;
    modelsSource?: string;
    error?: {
      category?: string;
      message?: string;
      retryable?: boolean;
      statusCode?: number;
    };
  };
  status?: ApiKeyStatus | string;
  configured?: boolean;
  masked?: string | null;
  maskedApiKey?: string | null;
  ok?: boolean;
  message?: string;
};

export type TaskEventRecord = {
  id: string;
  taskId: string;
  conversationId?: string;
  eventType: string;
  status?: TaskStatus | "retry" | (string & {});
  title?: string;
  detail?: string;
  errorMessage?: string;
  progress?: number;
  assetIds?: string[];
  retryOfTaskId?: string;
  retryTaskId?: string;
  summary?: string;
  details?: Record<string, unknown>;
  createdAt: string;
};

export type AdminModelCapabilityRecord = ModelRecord & {
  model: string;
  modality: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type AdminProviderMode = "mock" | "real" | (string & {});

export type AdminProviderAvailabilityStatus =
  | "available"
  | "missing"
  | "unknown"
  | (string & {});

export type AdminProviderWarning =
  | string
  | {
      code?: string;
      title?: string;
      message?: string;
      severity?: "info" | "warning" | "error" | (string & {});
    };

export type AdminProviderAlertSeverity =
  | "critical"
  | "warning"
  | "info"
  | "error"
  | (string & {});

export type AdminProviderAlert = {
  id: string;
  title?: string;
  message?: string;
  severity?: AdminProviderAlertSeverity;
  status?: string;
  taskId?: string | null;
  task?: Pick<TaskRecord, "id"> | null;
  createdAt?: string;
  updatedAt?: string;
  detectedAt?: string;
  triggeredAt?: string;
  occurredAt?: string;
  acknowledgedAt?: string | null;
  metadata?: Record<string, unknown>;
};

export type AdminProviderAlertSummary = {
  activeAlerts?: number;
  activeCount?: number;
  totalActive?: number;
  criticalAlerts?: number;
  criticalCount?: number;
  warningAlerts?: number;
  warningCount?: number;
  infoAlerts?: number;
  infoCount?: number;
};

export type AdminProviderModelAvailability = {
  id?: string;
  model?: string;
  modelId?: string;
  name?: string;
  enabled?: boolean;
  status?: AdminProviderAvailabilityStatus;
  availability?: AdminProviderAvailabilityStatus;
  message?: string;
  hint?: string;
  reason?: string;
  capabilityTypes?: string[];
};

export type AdminProviderStatus = {
  id?: string;
  name: string;
  type: string;
  baseUrl?: string | null;
  apiKeyConfigured: boolean;
  maskedApiKey?: string | null;
  mode: AdminProviderMode;
  supportedCapabilities?: string[];
  defaultModels?: Partial<Record<string, string>>;
  defaultGenerateModel?: string | null;
  defaultEditModel?: string | null;
  models?: Array<{
    id: string;
    name: string;
    enabled: boolean;
    capabilityTypes: string[];
    remoteAvailable?: boolean;
  }>;
  lastCheck?: AdminProviderCheckResult;
  lastTest?: AdminProviderTestGenerateResult;
  modelAvailability?: AdminProviderModelAvailability[];
  warnings?: AdminProviderWarning[];
  alerts?: AdminProviderAlert[];
  summary?: AdminProviderAlertSummary;
  updatedAt?: string;
};

export type AdminProviderCheckResult = {
  ok: boolean;
  status?: "healthy" | "degraded" | "unhealthy" | (string & {});
  message?: string;
  errorSummary?: string;
  checkedAt?: string;
  latencyMs?: number;
  provider?: AdminProviderStatus;
  details?: Record<string, unknown>;
};

export type AdminProviderTestGenerateResult = {
  ok?: boolean;
  taskId?: string;
  task?: TaskRecord;
  status?: string;
  message?: string;
  errorSummary?: string;
  failureSummary?: string;
  result?: Record<string, unknown> | string | null;
  assetIds?: string[];
  queuedAt?: string;
  createdAt?: string;
  completedAt?: string;
};

export type AdminLogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | (string & {});

export type AdminLogRecord = {
  id: string;
  timestamp: string;
  level: AdminLogLevel;
  context: string;
  message: string;
  trace?: string | Record<string, unknown> | null;
};

export type AdminLogsResponse = {
  logs: AdminLogRecord[];
  total?: number;
};

export type UiTaskAsset = {
  id: string;
  type: AssetRecord["type"];
  url?: string;
  storageKey?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  createdAt: string;
  label: string;
};

export type UiBatchSlot = {
  id: string;
  taskId: string;
  batchIndex: number;
  status: TaskStatus;
  progress: number;
  asset?: UiTaskAsset;
  errorMessage?: string;
  attempt: number;
};

export type UiTask = {
  id: string;
  title: string;
  progress: number;
  status: TaskStatus;
  eta: string;
  tags: string[];
  prompt?: string;
  capability?: CapabilityType;
  model?: string;
  createdAt?: string;
  updatedAt?: string;
  errorMessage?: string;
  summary?: string;
  inputAssets?: UiTaskAsset[];
  resultAssets?: UiTaskAsset[];
  assetIds?: string[];
  params?: Record<string, unknown>;
  failure?: ApiTaskFailure;
  canRetry?: boolean;
  conversationId?: string;
  conversationTitle?: string;
  sourceTaskId?: string;
  sourceAction?: TaskSourceAction;
  outputSummary?: Record<string, unknown>;
  inputSummary?: Record<string, unknown>;
  batch?: TaskBatchSummary;
  batchSlots?: UiBatchSlot[];
};

export type UiTaskRoundNavigation = {
  scope: "retry";
  groupId: string;
  taskIds: string[];
  index: number;
  total: number;
  previousTaskId?: string;
  nextTaskId?: string;
};

export type UiImageResult = {
  id: string;
  prompt: string;
  size: string;
  model: string;
  badge: string;
  url?: string;
  storageKey?: string;
};

export type {
  AssetRecord,
  CapabilityType,
  ConversationMetadata,
  ModelRecord,
  TaskMessage,
  TaskBatchItemRecord,
  TaskBatchSummary,
  TaskSourceAction,
  TaskStatus,
};
