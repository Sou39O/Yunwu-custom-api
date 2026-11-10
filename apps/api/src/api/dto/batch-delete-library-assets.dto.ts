import { ArrayNotEmpty, IsArray, IsString } from "class-validator";

export class BatchDeleteLibraryAssetsDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  ids!: string[];
}
