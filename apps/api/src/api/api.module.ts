import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { OpenAICompatibleModule } from "../openai-compatible/openai-compatible.module";
import { TasksModule } from "../tasks/tasks.module";
import { ApiController } from "./api.controller";
import { ConversationEventsModule } from "./conversation-events.module";
import { ApiService } from "./api.service";
import { AssetUploadService } from "./asset-upload.service";
import { AssetStorageService } from "./storage/asset-storage.service";
import { LocalAssetStorageService } from "./storage/local-asset-storage.service";
import { S3AssetStorageService } from "./storage/s3-asset-storage.service";
import { LibraryDownloadService } from "./library/library-download.service";
import { AssetPersistenceService } from "./storage/asset-persistence.service";

@Module({
  imports: [
    PrismaModule,
    OpenAICompatibleModule,
    TasksModule,
    ConversationEventsModule,
  ],
  controllers: [ApiController],
  providers: [
    ApiService,
    AssetUploadService,
    AssetStorageService,
    LocalAssetStorageService,
    S3AssetStorageService,
    LibraryDownloadService,
    AssetPersistenceService,
  ],
})
export class ApiModule {}
