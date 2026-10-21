export type AssetStorageKind = "local" | "s3";

export interface StoreAssetInput {
  buffer: Buffer;
  storageKey: string;
  mimeType: string;
}

export interface StoredAssetLocation {
  kind: AssetStorageKind;
  objectUrl?: string;
}

export interface LocalAssetContent {
  kind: "local";
  filePath: string;
  mimeType: string;
}

export interface RedirectAssetContent {
  kind: "redirect";
  redirectUrl: string;
}

/** 只保存了上游 URL、字节没有落盘的历史资产（早期生成时下载失败）。 */
export interface UpstreamUrlAssetContent {
  kind: "upstream-url";
  upstreamUrl: string;
}

export interface RemoteAssetContent {
  kind: "remote";
  buffer: Buffer;
  mimeType: string;
}

export interface MissingRemoteAssetContent {
  kind: "missing-remote-url";
  message: string;
}

export type AssetContentResolution =
  | LocalAssetContent
  | RedirectAssetContent
  | UpstreamUrlAssetContent
  | RemoteAssetContent
  | MissingRemoteAssetContent;
