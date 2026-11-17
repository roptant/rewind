import { ipcRenderer } from "electron";

type Listener = (...args: any) => any;

export type BeatmapMirrorId = "catboy" | "nerinyan" | "osudirect";
export type BeatmapImportTarget = "auto" | "lazer" | "stable";

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
  replayClient: "stable" | "lazer";
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

// Maybe use it for onUpdateDownloadProgress
interface UpdateInfo {
  total: number;
  transferred: number;
  bytesPerSecond: number;
}

export const frontendAPI = {
  getPath: (type: string) => ipcRenderer.invoke("getPath", type) as Promise<string>,
  selectDirectory: (defaultPath: string) => ipcRenderer.invoke("selectDirectory", defaultPath) as Promise<string | null>,
  selectFile: (defaultPath: string) => ipcRenderer.invoke("selectFile", defaultPath) as Promise<string | null>,
  reboot: () => ipcRenderer.invoke("reboot"),
  getAppVersion: () => ipcRenderer.invoke("getAppVersion") as Promise<string>,
  getPlatform: () => ipcRenderer.invoke("getPlatform") as Promise<string>,
  onManualReplayOpen: (listener: Listener) => ipcRenderer.on("onManualReplayOpen", (event, file) => listener(file)),
  onUpdateAvailable: (listener: Listener) => ipcRenderer.on("onUpdateAvailable", (event, version) => listener(version)),
  onUpdateDownloadProgress: (listener: Listener) =>
    ipcRenderer.on("onUpdateDownloadProgress", (event, info) => listener(info)),
  startDownloadingUpdate: () => ipcRenderer.invoke("startDownloadingUpdate"),
  onDownloadFinished: (listener: Listener) => ipcRenderer.on("onDownloadFinished", (event) => listener()),
  checkForUpdate: () => ipcRenderer.invoke("checkForUpdate"),
  quitAndInstall: () => ipcRenderer.invoke("quitAndInstall"),
  lookupBeatmapByMd5: (md5: string) =>
    ipcRenderer.invoke("lookupBeatmapByMd5", md5) as Promise<RemoteBeatmapMetadata>,
  downloadAndImportBeatmap: (request: BeatmapDownloadRequest) =>
    ipcRenderer.invoke("downloadAndImportBeatmap", request) as Promise<BeatmapDownloadResult>,
  flushPendingLazerImports: (lazerFolder: string) =>
    ipcRenderer.invoke("flushPendingLazerImports", lazerFolder) as Promise<number>,
  getBeatmapCacheFolder: () => ipcRenderer.invoke("getBeatmapCacheFolder") as Promise<string>,
  onBeatmapDownloadProgress: (listener: (progress: BeatmapDownloadProgressEvent) => void) => {
    const handler = (_event: unknown, progress: BeatmapDownloadProgressEvent) => listener(progress);
    ipcRenderer.on("onBeatmapDownloadProgress", handler);
    return () => {
      ipcRenderer.removeListener("onBeatmapDownloadProgress", handler);
    };
  },
};
