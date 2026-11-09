import { IsInt, IsOptional, Max, Min } from "class-validator";

export class AutoRetryTaskDto {
  /** 每轮重试的并发数，默认 20。 */
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20)
  batchSize?: number;
}
