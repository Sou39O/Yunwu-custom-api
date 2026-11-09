import type {
  AdminProviderAlert,
  AdminProviderAlertSummary,
  AdminLogRecord,
  AdminLogsResponse,
  AdminModelCapabilityRecord,
  AdminProviderModelAvailability,
  AdminProviderCheckResult,
  AdminProviderStatus,
  AdminProviderTestGenerateResult,
  ApiKeyMutationResponse,
  ConversationDetail,
  ConversationMutationResponse,
  ConversationSummary,
  CreateConversationInput,
  CreateTaskInput,
  CreateTaskResponse,
  DeleteLibraryAssetResponse,
  HistoryResponse,
  HomeResponse,
  LibraryResponse,
  ModelRecord,
  RetryTaskResponse,
  TaskRecord,
  TaskEventRecord,
  UploadAssetResponse,
} from "@/lib/api-types";
import { type UserSettings } from "@/lib/user-settings";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

function normalizeLoopbackApiBaseUrl(value: string) {
  if (typeof window === "undefined") {
    return value;
  }

  try {
    const url = new URL(value, window.location.origin);
    const pageHostname = window.location.hostname;

    if (
      LOOPBACK_HOSTS.has(pageHostname) &&
      LOOPBACK_HOSTS.has(url.hostname) &&
      url.hostname !== pageHostname
    ) {
      url.hostname = pageHostname;
    }

    return url.toString();
  } catch {
    return value;
  }
}

export function resolveDefaultApiBaseUrl(
  location: Pick<Location, "origin" | "protocol" | "hostname"> | undefined,
  isDevBuild: boolean,
) {
  if (!location) {
    return "http://127.0.0.1:3000";
  }

  // 生产包由内置 API 服务自己托管页面，页面 origin 上就带着本次实际端口。
  // 端口 3000 被占用时桌面端会换随机端口，写死 3000 会把请求发到别的服务上。
  if (!isDevBuild) {
    return location.origin;
  }

  return `${location.protocol}//${location.hostname}:3000`;
}

function getDefaultApiBaseUrl() {
  return resolveDefaultApiBaseUrl(
    typeof window === "undefined" ? undefined : window.location,
    import.meta.env.DEV,
  );
}

function normalizeApiRoot(value: string | undefined) {
  const configured = value?.trim();
  if (configured && /^\/+$/.test(configured)) {
    return "/api";
  }

  const baseUrl = configured ? normalizeLoopbackApiBaseUrl(configured) : getDefaultApiBaseUrl();
  const withoutTrailingSlashes = baseUrl.replace(/\/+$/, "");

  if (!withoutTrailingSlashes || /^\/+$/.test(withoutTrailingSlashes)) {
    return "/api";
  }

  return withoutTrailingSlashes.endsWith("/api")
    ? withoutTrailingSlashes
    : `${withoutTrailingSlashes}/api`;
}

function joinApiPath(path: string) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_ROOT}${normalizedPath}`;
}

const API_ROOT = normalizeApiRoot(import.meta.env.VITE_API_BASE_URL);
const RAW_SSE_PATH_TEMPLATE =
  import.meta.env.VITE_CONVERSATION_SSE_PATH_TEMPLATE ??
  "/conversations/:id/events";

type RequestOptions = Omit<RequestInit, "body"> & {
  body?: unknown;
};

type RequestConfig = {
  allowUnauthorized?: boolean;
};

class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function readJsonBody<T>(response: Response): Promise<T> {
  const text = await response.text();

  if (!text.trim()) {
    return undefined as T;
  }

  return JSON.parse(text) as T;
}

async function request<T>(
  path: string,
  options: RequestOptions = {},
  config: RequestConfig = {},
): Promise<T> {
  const response = await fetch(joinApiPath(path), {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (
    config.allowUnauthorized &&
    (response.status === 401 || response.status === 403)
  ) {
    return undefined as T;
  }

  if (!response.ok) {
    let message = `API request failed: ${response.status}`;

    try {
      const body = (await response.json()) as {
        message?: string | string[];
        error?: string;
      };
      const bodyMessage = Array.isArray(body.message)
        ? body.message.join("; ")
        : body.message;
      message = bodyMessage ?? body.error ?? message;
    } catch {
      // Keep the status-based message when the response is not JSON.
    }

    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return readJsonBody<T>(response);
}

async function requestForm<T>(path: string, formData: FormData): Promise<T> {
  const response = await fetch(joinApiPath(path), {
    method: "POST",
    credentials: "include",
    body: formData,
  });

  if (!response.ok) {
    let message = `API request failed: ${response.status}`;

    try {
      const body = (await response.json()) as {
        message?: string | string[];
        error?: string;
      };
      const bodyMessage = Array.isArray(body.message)
        ? body.message.join("; ")
        : body.message;
      message = bodyMessage ?? body.error ?? message;
    } catch {
      // Keep the status-based message when the response is not JSON.
    }

    throw new ApiError(message, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return readJsonBody<T>(response);
}

function unwrapList<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) {
    return payload as T[];
  }

  if (payload && typeof payload === "object") {
    const value = (payload as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      return value as T[];
    }
  }

  return [];
}

function unwrapObject<T>(payload: unknown, key: string): T {
  if (payload && typeof payload === "object" && key in payload) {
    return (payload as Record<string, unknown>)[key] as T;
  }

  return payload as T;
}

function unwrapObjectWithKeys<T>(payload: unknown, keys: string[]): T {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const match = keys.find((key) => key in record);
    if (match) {
      return record[match] as T;
    }
  }

  return payload as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : undefined;
}

function normalizeProviderModelAvailability(
  value: unknown,
): AdminProviderModelAvailability[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter(isRecord).map((item) => ({
    ...item,
    capabilityTypes: normalizeStringArray(item.capabilityTypes),
  })) as AdminProviderModelAvailability[];
}

function normalizeAdminProviderAlerts(
  value: unknown,
): AdminProviderAlert[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .filter(isRecord)
    .map(
      (item) =>
        ({
          ...item,
          id:
            typeof item.id === "string"
              ? item.id
              : typeof item.alertId === "string"
                ? item.alertId
                : "",
          taskId:
            typeof item.taskId === "string"
              ? item.taskId
              : isRecord(item.task) && typeof item.task.id === "string"
                ? item.task.id
                : null,
          task:
            isRecord(item.task) && typeof item.task.id === "string"
              ? ({ id: item.task.id } as Pick<TaskRecord, "id">)
              : null,
        }) as AdminProviderAlert,
    )
    .filter((item) => Boolean(item.id));
}

function normalizeAdminProviderAlertSummary(
  value: unknown,
): AdminProviderAlertSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return value as AdminProviderAlertSummary;
}

function normalizeAdminProviderTestResultFields(
  value: Record<string, unknown>,
): AdminProviderTestGenerateResult {
  const error = isRecord(value.error) ? value.error : undefined;
  const task = isRecord(value.task)
    ? (value.task as unknown as TaskRecord)
    : undefined;
  const test = isRecord(value.test) ? value.test : undefined;

  return {
    ...value,
    task,
    taskId: typeof value.taskId === "string" ? value.taskId : task?.id,
    status:
      typeof value.status === "string"
        ? value.status
        : typeof test?.status === "string"
          ? test.status
          : task?.status,
    message:
      typeof value.message === "string"
        ? value.message
        : typeof error?.message === "string"
          ? error.message
          : undefined,
    errorSummary:
      typeof value.errorSummary === "string"
        ? value.errorSummary
        : typeof value.failureSummary === "string"
          ? value.failureSummary
          : typeof value.errorMessage === "string"
            ? value.errorMessage
            : typeof task?.errorMessage === "string"
              ? task.errorMessage
              : typeof error?.message === "string"
                ? error.message
                : undefined,
    queuedAt:
      typeof value.queuedAt === "string"
        ? value.queuedAt
        : typeof test?.queuedAt === "string"
          ? test.queuedAt
          : undefined,
  } as AdminProviderTestGenerateResult;
}

function normalizeAdminProviderStatus(payload: unknown): AdminProviderStatus {
  const root = isRecord(payload) ? payload : undefined;
  const status = unwrapObjectWithKeys<AdminProviderStatus>(payload, [
    "provider",
    "status",
  ]);

  if (!isRecord(status)) {
    return status;
  }

  const statusRecord = status as Record<string, unknown>;
  const defaultModels = isRecord(statusRecord.defaultModels)
    ? statusRecord.defaultModels
    : {};
  const lastCheck = isRecord(statusRecord.lastCheck)
    ? normalizeAdminProviderCheckResult(statusRecord.lastCheck)
    : undefined;
  const lastTest = isRecord(statusRecord.lastTest)
    ? normalizeProviderTestGenerateResult(statusRecord.lastTest)
    : undefined;
  const modelAvailability = normalizeProviderModelAvailability(
    statusRecord.modelAvailability ?? statusRecord.modelAvailabilities,
  );
  const warnings = Array.isArray(statusRecord.warnings)
    ? statusRecord.warnings
    : undefined;
  const alerts = normalizeAdminProviderAlerts(
    statusRecord.alerts ?? root?.alerts ?? root?.providerAlerts,
  );
  const summary = normalizeAdminProviderAlertSummary(
    statusRecord.summary ??
      statusRecord.alertSummary ??
      root?.summary ??
      root?.alertSummary,
  );

  return {
    ...status,
    defaultGenerateModel:
      typeof status.defaultGenerateModel === "string"
        ? status.defaultGenerateModel
        : typeof defaultModels["image.generate"] === "string"
          ? defaultModels["image.generate"]
          : null,
    defaultEditModel:
      typeof status.defaultEditModel === "string"
        ? status.defaultEditModel
        : typeof defaultModels["image.edit"] === "string"
          ? defaultModels["image.edit"]
          : null,
    ...(lastCheck ? { lastCheck } : {}),
    ...(lastTest ? { lastTest } : {}),
    ...(modelAvailability ? { modelAvailability } : {}),
    ...(warnings ? { warnings } : {}),
    ...(alerts ? { alerts } : {}),
    ...(summary ? { summary } : {}),
  } as AdminProviderStatus;
}

function normalizeAdminProviderCheckResult(
  payload: unknown,
): AdminProviderCheckResult {
  const response = isRecord(payload) ? payload : {};
  const check = unwrapObjectWithKeys<AdminProviderCheckResult>(payload, [
    "check",
    "result",
    "health",
  ]);
  const normalizedCheck: Record<string, unknown> = isRecord(check) ? check : {};
  const status =
    typeof normalizedCheck.status === "string"
      ? normalizedCheck.status
      : undefined;
  const error = isRecord(normalizedCheck.error)
    ? normalizedCheck.error
    : undefined;

  return {
    ...normalizedCheck,
    ok:
      typeof normalizedCheck.ok === "boolean"
        ? normalizedCheck.ok
        : status === "ok" || status === "healthy",
    status,
    errorSummary:
      typeof normalizedCheck.errorSummary === "string"
        ? normalizedCheck.errorSummary
        : typeof error?.message === "string"
          ? error.message
          : undefined,
    provider: isRecord(response.provider)
      ? normalizeAdminProviderStatus(response.provider)
      : isRecord(normalizedCheck.provider)
        ? normalizeAdminProviderStatus(normalizedCheck.provider)
        : undefined,
    details:
      isRecord(normalizedCheck.details) || !isRecord(normalizedCheck)
        ? normalizedCheck.details
        : normalizedCheck,
  } as AdminProviderCheckResult;
}

function normalizeProviderTestGenerateResult(
  payload: unknown,
): AdminProviderTestGenerateResult {
  if (!isRecord(payload)) {
    return { result: payload as AdminProviderTestGenerateResult["result"] };
  }

  if (isRecord(payload.testGenerate)) {
    return normalizeAdminProviderTestResultFields(payload.testGenerate);
  }

  if (isRecord(payload.task)) {
    return normalizeAdminProviderTestResultFields(payload);
  }

  if ("result" in payload && !isRecord(payload.result)) {
    return {
      ...payload,
      result: payload.result as AdminProviderTestGenerateResult["result"],
    } as AdminProviderTestGenerateResult;
  }

  if (isRecord(payload.result)) {
    return {
      ...normalizeAdminProviderTestResultFields(payload.result),
      result: payload.result as AdminProviderTestGenerateResult["result"],
    } as AdminProviderTestGenerateResult;
  }

  return normalizeAdminProviderTestResultFields(payload);
}

function normalizeAdminLogRecord(value: unknown, index: number): AdminLogRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const timestamp =
    typeof value.timestamp === "string"
      ? value.timestamp
      : typeof value.createdAt === "string"
        ? value.createdAt
        : typeof value.time === "string"
          ? value.time
          : typeof value.ts === "string"
            ? value.ts
            : new Date().toISOString();
  const level =
    typeof value.level === "string"
      ? value.level.toUpperCase()
      : typeof value.severity === "string"
        ? value.severity.toUpperCase()
        : "INFO";
  const context =
    typeof value.context === "string"
      ? value.context
      : typeof value.scope === "string"
        ? value.scope
        : typeof value.module === "string"
          ? value.module
          : "-";
  const message =
    typeof value.message === "string"
      ? value.message
      : typeof value.msg === "string"
        ? value.msg
        : typeof value.summary === "string"
          ? value.summary
          : JSON.stringify(value);

  return {
    id:
      typeof value.id === "string"
        ? value.id
        : typeof value.logId === "string"
          ? value.logId
          : `${timestamp}-${index}`,
    timestamp,
    level,
    context,
    message,
    trace:
      typeof value.trace === "string" || isRecord(value.trace)
        ? value.trace
        : typeof value.stack === "string"
          ? value.stack
          : null,
  };
}

function normalizeAdminLogsResponse(payload: unknown): AdminLogsResponse {
  const root = isRecord(payload) ? payload : {};
  const rawLogs =
    Array.isArray(payload)
      ? payload
      : Array.isArray(root.logs)
        ? root.logs
        : Array.isArray(root.items)
          ? root.items
          : Array.isArray(root.records)
            ? root.records
            : Array.isArray(root.data)
              ? root.data
              : [];

  const total =
    typeof root.total === "number"
      ? root.total
      : typeof root.count === "number"
        ? root.count
        : undefined;

  return {
    logs: rawLogs
      .map((item, index) => normalizeAdminLogRecord(item, index))
      .filter((item): item is AdminLogRecord => Boolean(item)),
    total,
  };
}

function normalizeAdminLogRequestLevel(level: string) {
  const normalizedLevel = level.toUpperCase();

  if (normalizedLevel === "DEBUG") {
    return "debug";
  }

  if (normalizedLevel === "INFO") {
    return "log";
  }

  if (normalizedLevel === "WARN") {
    return "warn";
  }

  if (normalizedLevel === "ERROR") {
    return "error";
  }

  if (normalizedLevel === "ALL") {
    return "all";
  }

  return level.toLowerCase();
}

type SessionResponse = {
  user: {
    id: string;
    email: string;
    displayName?: string | null;
    role?: string | null;
    metadata?: Record<string, unknown>;
  };
};

export const apiClient = {
  getBaseUrl: () => API_ROOT,

  getConversationEventsUrl(id: string) {
    const normalizedPath = RAW_SSE_PATH_TEMPLATE.startsWith("/")
      ? RAW_SSE_PATH_TEMPLATE
      : `/${RAW_SSE_PATH_TEMPLATE}`;
    return joinApiPath(normalizedPath.replace(":id", encodeURIComponent(id)));
  },

  async getSession() {
    return request<SessionResponse | null>(
      "/auth/me",
      {},
      { allowUnauthorized: true },
    );
  },

  async login(input: { email: string; password: string }) {
    return request<SessionResponse>("/auth/login", {
      method: "POST",
      body: input,
    });
  },

  async register(input: {
    email: string;
    password: string;
    displayName?: string;
  }) {
    return request<SessionResponse>("/auth/register", {
      method: "POST",
      body: input,
    });
  },

  async logout() {
    await request<void>(
      "/auth/logout",
      {
        method: "POST",
      },
      { allowUnauthorized: true },
    );
  },

  async listConversations() {
    const payload = await request<unknown>("/conversations");
    return unwrapList<ConversationSummary>(payload, "conversations");
  },

  async getConversation(id: string) {
    const payload = await request<unknown>(
      `/conversations/${encodeURIComponent(id)}`,
    );
    return unwrapObject<ConversationDetail>(payload, "conversation");
  },

  async listConversationTaskEvents(id: string) {
    const payload = await request<unknown>(
      `/conversations/${encodeURIComponent(id)}/task-events`,
    );
    const events = unwrapList<TaskEventRecord>(payload, "events");
    return events.length > 0
      ? events
      : unwrapList<TaskEventRecord>(payload, "taskEvents");
  },

  async createConversation(input: CreateConversationInput) {
    const payload = await request<unknown>("/conversations", {
      method: "POST",
      body: input,
    });
    return unwrapObject<ConversationDetail>(payload, "conversation");
  },

  async archiveConversation(id: string) {
    return request<ConversationMutationResponse>(
      `/conversations/${encodeURIComponent(id)}/archive`,
      {
        method: "PATCH",
      },
    );
  },

  async deleteConversation(id: string) {
    return request<ConversationMutationResponse>(
      `/conversations/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      },
    );
  },

  async listModels() {
    const payload = await request<unknown>("/models");
    return unwrapList<ModelRecord>(payload, "models");
  },

  async getUserSettings() {
    return request<unknown>("/settings");
  },

  async updateUserSettings(
    input: UserSettings,
    options: { includeModels?: boolean } = {},
  ) {
    // 切线路时不要把上一条线路的模型列表带过去：
    // 三条线路的模型清单互不相同，服务端会按目标线路自己的选择恢复。
    const includeModels = options.includeModels !== false;
    return request<unknown>("/settings", {
      method: "PATCH",
      body: {
        activeProviderRouteId: input.providerRouteId,
        baseUrl: input.baseUrl,
        ...(includeModels ? { enabledModelIds: input.availableModelIds } : {}),
        ui: {
          ...input.ui,
          theme: input.theme,
          themePreset: input.themePreset,
          darkPreset: input.darkPreset,
          lightPreset: input.lightPreset,
          customColor: input.customColor,
          customTheme: input.customTheme,
        },
      },
    });
  },

  async updateUserApiKey(apiKey: string) {
    return request<ApiKeyMutationResponse>("/settings", {
      method: "PATCH",
      body: { apiKey },
    });
  },

  async verifyUserApiKey(apiKey?: string) {
    const response = await request<ApiKeyMutationResponse>("/settings/api-key/check", {
      method: "POST",
      body: apiKey ? { apiKey } : {},
    });
    if (response.ok === false) {
      throw new ApiError(response.message ?? "API key connectivity check failed.");
    }

    return response;
  },

  async clearUserApiKey() {
    return request<ApiKeyMutationResponse>("/settings", {
      method: "PATCH",
      body: { apiKey: null },
    });
  },

  async updateProviderRouteApiKey(routeId: string, apiKey: string) {
    return request<ApiKeyMutationResponse>(
      `/settings/provider-routes/${encodeURIComponent(routeId)}/api-key`,
      { method: "PUT", body: { apiKey } },
    );
  },

  async clearProviderRouteApiKey(routeId: string) {
    return request<ApiKeyMutationResponse>(
      `/settings/provider-routes/${encodeURIComponent(routeId)}/api-key`,
      { method: "DELETE" },
    );
  },

  async checkProviderRouteApiKey(routeId: string, apiKey?: string) {
    const response = await request<ApiKeyMutationResponse>(
      `/settings/provider-routes/${encodeURIComponent(routeId)}/api-key/check`,
      { method: "POST", body: apiKey ? { apiKey } : {} },
    );
    if (response.ok === false) {
      throw new ApiError(response.message ?? "API key connectivity check failed.");
    }

    return response;
  },

  async switchProviderRoute(routeId: string) {
    return request<ApiKeyMutationResponse>("/settings", {
      method: "PATCH",
      body: { activeProviderRouteId: routeId },
    });
  },

  async listTasks() {
    const payload = await request<unknown>("/tasks");
    return unwrapList<TaskRecord>(payload, "tasks");
  },

  async getTaskEvents(id: string) {
    const payload = await request<unknown>(
      `/tasks/${encodeURIComponent(id)}/events`,
    );
    return unwrapList<TaskEventRecord>(payload, "events");
  },

  async retryTask(
    id: string,
    options: {
      batchRetryCount?: number;
    } = {},
  ) {
    const payload = await request<RetryTaskResponse>(
      `/tasks/${encodeURIComponent(id)}/retry`,
      {
        method: "POST",
        body:
          options.batchRetryCount === undefined
            ? undefined
            : { batchRetryCount: options.batchRetryCount },
      },
    );
    return payload.task;
  },

  async listAdminModelCapabilities() {
    const payload = await request<unknown>("/admin/model-capabilities");
    return unwrapList<AdminModelCapabilityRecord>(payload, "modelCapabilities");
  },

  async getAdminProvider() {
    const payload = await request<unknown>("/admin/provider");
    return normalizeAdminProviderStatus(payload);
  },

  async checkAdminProvider() {
    const payload = await request<unknown>("/admin/provider/check", {
      method: "POST",
    });
    return normalizeAdminProviderCheckResult(payload);
  },

  async testGenerateAdminProvider() {
    const payload = await request<unknown>("/admin/provider/test-generate", {
      method: "POST",
    });
    return normalizeProviderTestGenerateResult(payload);
  },

  async acknowledgeAdminProviderAlert(id: string) {
    await request<void>(
      `/admin/provider/alerts/${encodeURIComponent(id)}/ack`,
      {
        method: "POST",
      },
    );
  },

  async listAdminLogs(
    options: {
      level?: string;
      search?: string;
      limit?: number;
    } = {},
  ) {
    const params = new URLSearchParams();
    if (options.level) {
      params.set("level", normalizeAdminLogRequestLevel(options.level));
    }
    if (options.search?.trim()) {
      params.set("search", options.search.trim());
    }
    if (typeof options.limit === "number" && Number.isFinite(options.limit)) {
      params.set("limit", String(options.limit));
    }

    const query = params.toString();
    const payload = await request<unknown>(`/admin/logs${query ? `?${query}` : ""}`);
    return normalizeAdminLogsResponse(payload);
  },

  async updateAdminModelCapability(id: string, input: { enabled: boolean }) {
    const payload = await request<unknown>(
      `/admin/model-capabilities/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: input,
      },
    );
    return unwrapObject<AdminModelCapabilityRecord>(payload, "modelCapability");
  },

  async createTask(input: CreateTaskInput) {
    return request<CreateTaskResponse>("/tasks", {
      method: "POST",
      body: input,
    });
  },

  async uploadAsset(file: File, options: { conversationId?: string } = {}) {
    const formData = new FormData();
    formData.append("file", file);

    if (options.conversationId) {
      formData.append("conversationId", options.conversationId);
    }

    return requestForm<UploadAssetResponse>("/assets/upload", formData);
  },

  async getTask(id: string) {
    const payload = await request<unknown>(`/tasks/${encodeURIComponent(id)}`);
    return unwrapObject<TaskRecord>(payload, "task");
  },

  async getHome() {
    return request<HomeResponse>("/home");
  },

  async getHistory() {
    return request<HistoryResponse>("/history");
  },

  async getLibrary() {
    return request<LibraryResponse>("/library");
  },

  async deleteLibraryAsset(id: string) {
    return request<DeleteLibraryAssetResponse>(
      `/library/assets/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      },
    );
  },

  /**
   * 批量下载作品库内容。返回服务端打包好的 zip 流，
   * 由调用方触发浏览器下载；文件名规则在服务端（日期 + 哈希前几位）。
   */
  async downloadLibraryAssets(assetIds: string[]) {
    const response = await fetch(joinApiPath("/library/download"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assetIds }),
    });

    if (!response.ok) {
      let message = `下载失败：${response.status}`;
      try {
        const payload = (await response.json()) as { message?: string | string[] };
        const raw = payload.message;
        if (Array.isArray(raw)) {
          message = raw.join("；");
        } else if (typeof raw === "string" && raw) {
          message = raw;
        }
      } catch {
        // 响应不是 JSON（例如网关错误页），保留状态码信息即可。
      }
      throw new Error(message);
    }

    return response.blob();
  },
};

export { ApiError };
