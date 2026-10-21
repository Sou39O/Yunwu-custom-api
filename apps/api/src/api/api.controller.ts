import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  MessageEvent,
  NotFoundException,
  NotImplementedException,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
  Sse,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { Observable } from "rxjs";
import { FileInterceptor } from "@nestjs/platform-express";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type {
  ConversationEvent,
  ArchiveConversationResponse,
  CapabilitiesResponse,
  ConversationTaskEventsResponse,
  ConversationResponse,
  ConversationsResponse,
  CreateTaskResponse,
  DeleteConversationResponse,
  DeleteLibraryAssetResponse,
  HistoryResponse,
  HomeResponse,
  AdminLogsResponse,
  AdminModelCapabilitiesResponse,
  AdminModelCapabilityResponse,
  LibraryResponse,
  ModelsResponse,
  ProviderAdminResponse,
  ProviderCheckResponse,
  ProviderTestGenerateResponse,
  RetryTaskResponse,
  TasksResponse,
  TaskEventsResponse,
  TaskResponse,
  UserApiKeyCheckResponse,
  UserSettingsResponse,
  UploadAssetResponse,
} from "./api.types";
import { ApiService } from "./api.service";
import { LibraryDownloadService } from "./library/library-download.service";
import { AssetUploadService } from "./asset-upload.service";
import { ConversationEventsService } from "./conversation-events.service";
import { CurrentUser } from "../auth/current-user.decorator";
import { Roles } from "../auth/roles.decorator";
import type { AuthenticatedUser } from "../auth/auth.types";
import { CheckUserApiKeyDto } from "./dto/check-user-api-key.dto";
import { CreateConversationDto } from "./dto/create-conversation.dto";
import { CreateTaskDto } from "./dto/create-task.dto";
import { RetryTaskDto } from "./dto/retry-task.dto";
import { TestGenerateProviderDto } from "./dto/test-generate-provider.dto";
import { UpdateModelCapabilityDto } from "./dto/update-model-capability.dto";
import { UpdateProviderConfigDto } from "./dto/update-provider-config.dto";
import { UpdateProviderRouteApiKeyDto } from "./dto/update-provider-route-api-key.dto";
import { UpdateUserSettingsDto } from "./dto/update-user-settings.dto";
import { DownloadLibraryAssetsDto } from "./dto/download-library-assets.dto";
import {
  AppLoggerService,
  type AppLogLevelQuery,
} from "../logging/app-logger.service";
import type { UploadedAssetFile } from "./upload.types";

@Controller("api")
export class ApiController {
  constructor(
    private readonly api: ApiService,
    private readonly libraryDownload: LibraryDownloadService,
    private readonly assetUpload: AssetUploadService,
    private readonly conversationEvents: ConversationEventsService,
    private readonly appLogger: AppLoggerService,
  ) {}

  @Get("capabilities")
  getCapabilities(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CapabilitiesResponse> {
    return this.api.getCapabilities(user);
  }

  @Get("models")
  getModels(@CurrentUser() user: AuthenticatedUser): Promise<ModelsResponse> {
    return this.api.getModels(user);
  }

  @Get("settings")
  getSettings(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<UserSettingsResponse> {
    return this.api.getSettings(user);
  }

  @Patch("settings")
  updateSettings(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: UpdateUserSettingsDto,
  ): Promise<UserSettingsResponse> {
    return this.api.updateSettings(user, input);
  }

  @Post("settings/api-key/check")
  checkUserApiKey(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CheckUserApiKeyDto,
  ): Promise<UserApiKeyCheckResponse> {
    return this.api.checkUserApiKey(user, input);
  }

  @Put("settings/provider-routes/:routeId/api-key")
  updateProviderRouteApiKey(
    @CurrentUser() user: AuthenticatedUser,
    @Param("routeId") routeId: string,
    @Body() input: UpdateProviderRouteApiKeyDto,
  ) {
    return this.api.updateProviderRouteApiKey(user, routeId, input.apiKey);
  }

  @Delete("settings/provider-routes/:routeId/api-key")
  clearProviderRouteApiKey(
    @CurrentUser() user: AuthenticatedUser,
    @Param("routeId") routeId: string,
  ) {
    return this.api.clearProviderRouteApiKey(user, routeId);
  }

  @Post("settings/provider-routes/:routeId/api-key/check")
  checkProviderRouteApiKey(
    @CurrentUser() user: AuthenticatedUser,
    @Param("routeId") routeId: string,
    @Body() input: CheckUserApiKeyDto,
  ) {
    return this.api.checkProviderRouteApiKey(user, routeId, input.apiKey);
  }

  @Get("conversations")
  getConversations(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ConversationsResponse> {
    return this.api.getConversations(user);
  }

  @Post("conversations")
  createConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateConversationDto,
  ): Promise<ConversationResponse> {
    return this.api.createConversation(user, input);
  }

  @Get("conversations/:id")
  getConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<ConversationResponse> {
    return this.api.getConversation(user, id);
  }

  @Patch("conversations/:id/archive")
  archiveConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<ArchiveConversationResponse> {
    return this.api.archiveConversation(user, id);
  }

  @Delete("conversations/:id")
  deleteConversation(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<DeleteConversationResponse> {
    return this.api.deleteConversation(user, id);
  }

  @Get("home")
  getHome(@CurrentUser() user: AuthenticatedUser): Promise<HomeResponse> {
    return this.api.getHome(user);
  }

  @Get("history")
  getHistory(@CurrentUser() user: AuthenticatedUser): Promise<HistoryResponse> {
    return this.api.getHistory(user);
  }

  @Get("library")
  getLibrary(@CurrentUser() user: AuthenticatedUser): Promise<LibraryResponse> {
    return this.api.getLibrary(user);
  }

  @Delete("library/assets/:id")
  deleteLibraryAsset(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<DeleteLibraryAssetResponse> {
    return this.api.deleteLibraryAsset(user, id);
  }

  @Post("library/download")
  downloadLibraryAssets(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: DownloadLibraryAssetsDto,
    @Res({ passthrough: true })
    response: {
      setHeader: (name: string, value: string) => void;
    },
  ): StreamableFile {
    const stream = this.libraryDownload.streamDownload(user, input.assetIds);
    const zipName = `yunwu-library-${new Date().toISOString().slice(0, 10)}.zip`;

    response.setHeader("Content-Type", "application/zip");
    response.setHeader(
      "Content-Disposition",
      `attachment; filename="${zipName}"; filename*=UTF-8''${zipName}`,
    );

    return new StreamableFile(Readable.from(stream));
  }

  @Get("conversations/:id/task-events")
  getConversationTaskEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<ConversationTaskEventsResponse> {
    return this.api.getConversationTaskEvents(user, id);
  }

  @Sse("conversations/:id/events")
  @Header("Cache-Control", "no-cache, no-transform")
  @Header("X-Accel-Buffering", "no")
  async getConversationEvents(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<Observable<MessageEvent & { data: ConversationEvent }>> {
    await this.api.assertConversationAccess(user, id);
    return this.conversationEvents.createStream(id);
  }

  @Post("tasks")
  createTask(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: CreateTaskDto,
  ): Promise<CreateTaskResponse> {
    return this.api.createTask(user, input);
  }

  @Post("assets/upload")
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { files: 1, fileSize: 20 * 1024 * 1024 },
    }),
  )
  async uploadAsset(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile() file: UploadedAssetFile,
  ): Promise<UploadAssetResponse> {
    return { asset: await this.assetUpload.upload(user, file) };
  }

  @Get("assets/:storageKey/content")
  async getAssetContent(
    @CurrentUser() user: AuthenticatedUser,
    @Param("storageKey") storageKey: string,
    @Res({ passthrough: true })
    response: {
      setHeader: (name: string, value: string) => void;
      statusCode: number;
    },
  ): Promise<StreamableFile | void> {
    const asset = await this.assetUpload.getAssetContent(user, storageKey);
    if (!asset) {
      throw new NotFoundException("Asset not found.");
    }

    if (asset.kind === "redirect") {
      response.statusCode = 302;
      response.setHeader("Location", asset.redirectUrl);
      return undefined;
    }
    // 只留了上游地址的历史资产：直接跳转，避免把过期链接挡在本地。
    if (asset.kind === "upstream-url") {
      response.statusCode = 302;
      response.setHeader("Location", asset.upstreamUrl);
      return undefined;
    }
    if (asset.kind === "missing-remote-url") {
      throw new NotImplementedException(asset.message);
    }

    response.setHeader("Content-Type", asset.mimeType);
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (asset.kind === "local") {
      return new StreamableFile(createReadStream(asset.filePath));
    }

    return new StreamableFile(asset.buffer);
  }

  @Get("tasks")
  @Roles("admin")
  getTasks(@CurrentUser() user: AuthenticatedUser): Promise<TasksResponse> {
    return this.api.getTasks(user);
  }

  @Get("tasks/:id/events")
  @Roles("admin")
  getTaskEvents(@Param("id") id: string): Promise<TaskEventsResponse> {
    return this.api.getTaskEvents(id);
  }

  @Post("tasks/:id/retry")
  retryTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
    @Body() input: RetryTaskDto = {},
  ): Promise<RetryTaskResponse> {
    return this.api.retryTask(user, id, input);
  }

  @Get("tasks/:id")
  getTask(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id") id: string,
  ): Promise<TaskResponse> {
    return this.api.getTask(user, id);
  }

  @Get("admin/model-capabilities")
  @Roles("admin")
  getAdminModelCapabilities(): Promise<AdminModelCapabilitiesResponse> {
    return this.api.getAdminModelCapabilities();
  }

  @Get("admin/logs")
  @Roles("admin")
  getAdminLogs(
    @Query("level") level?: AppLogLevelQuery,
    @Query("limit") limit?: string,
    @Query("search") search?: string,
  ): AdminLogsResponse {
    return this.appLogger.queryLogs({
      level,
      limit: limit === undefined ? undefined : Number(limit),
      search,
    });
  }

  @Get("admin/provider")
  @Roles("admin")
  getAdminProvider(): Promise<ProviderAdminResponse> {
    return this.api.getAdminProvider();
  }

  @Post("admin/provider/check")
  @Roles("admin")
  checkAdminProvider(): Promise<ProviderCheckResponse> {
    return this.api.checkAdminProvider();
  }

  @Patch("admin/provider/config")
  @Roles("admin")
  updateAdminProviderConfig(
    @Body() input: UpdateProviderConfigDto,
  ): Promise<ProviderAdminResponse> {
    return this.api.updateAdminProviderConfig(input);
  }

  @Post("admin/provider/test-generate")
  @Roles("admin")
  testGenerateAdminProvider(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: TestGenerateProviderDto,
  ): Promise<ProviderTestGenerateResponse> {
    return this.api.testGenerateAdminProvider(user, input);
  }

  @Post("admin/provider/alerts/:id/ack")
  @Roles("admin")
  acknowledgeAdminProviderAlert(
    @Param("id") id: string,
  ): Promise<ProviderAdminResponse> {
    return this.api.acknowledgeAdminProviderAlert(id);
  }

  @Patch("admin/model-capabilities/:id")
  @Roles("admin")
  updateAdminModelCapability(
    @Param("id") id: string,
    @Body() input: UpdateModelCapabilityDto,
  ): Promise<AdminModelCapabilityResponse> {
    return this.api.updateAdminModelCapability(id, input);
  }
}
