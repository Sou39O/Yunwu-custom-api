import { Global, Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { TaskAutoRetryService } from "./task-auto-retry.service";
import { TaskEventsService } from "./task-events.service";
import { TaskQueueService } from "./task-queue.service";

@Global()
@Module({
  imports: [PrismaModule],
  providers: [TaskEventsService, TaskQueueService, TaskAutoRetryService],
  exports: [TaskEventsService, TaskQueueService, TaskAutoRetryService],
})
export class TasksModule {}
