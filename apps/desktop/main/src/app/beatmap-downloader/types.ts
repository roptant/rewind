export type BeatmapMirrorId = "catboy" | "nerinyan" | "osudirect";

export type BeatmapImportTarget = "auto" | "lazer" | "stable";

export type BeatmapClientType = "stable" | "lazer";

export interface RemoteBeatmapMetadata {
  md5: string;
  beatmapId: number;
  beatmapSetId: number;
  title: string;
  artist: string;
  creator: string;
  difficultyName: string;
  status: number;
}

export interface BeatmapDownloadProgressEvent {
  md5: string;
  stage: "resolving" | "downloading" | "importing";
  title?: string;
  artist?: string;
  difficultyName?: string;
  mirror?: string;
  transferredBytes?: number;
  totalBytes?: number;
}

export interface BeatmapDownloadRequest {
  md5: string;
  replayClient: BeatmapClientType;
  preferredTarget: BeatmapImportTarget;
  preferredMirror: BeatmapMirrorId;
  noVideo: boolean;
  stableSongsFolder?: string;
  lazerFolder?: string;
}

export interface BeatmapDownloadResult {
  importedTo: "lazer" | "stable" | "cache";
  folderName?: string;
  metadata: RemoteBeatmapMetadata;
  warning?: string;
}
