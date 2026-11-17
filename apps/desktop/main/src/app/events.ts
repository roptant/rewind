import { app, dialog, ipcMain } from "electron";
import { read } from "node-osr";
import { readFile } from "fs/promises";
import { isLazerReplayVersion, readLazerScoreInfo } from "@rewind/osu-local/osr-reader";
import { BeatmapDownloadService } from "./beatmap-downloader/BeatmapDownloadService";
import { BeatmapMirrorClient } from "./beatmap-downloader/BeatmapMirrorClient";
import { BeatmapDownloadRequest } from "./beatmap-downloader/types";
import { windows } from "./windows";

async function userSelectDirectory(defaultPath: string) {
  const { canceled, filePaths } = await dialog.showOpenDialog({ defaultPath, properties: ["openDirectory"] });
  if (canceled || filePaths.length === 0) {
    return null;
  } else {
    return filePaths[0];
  }
}

async function userSelectFile(defaultPath: string) {
  const { canceled, filePaths } = await dialog.showOpenDialog({ defaultPath, properties: ["openFile"] });
  if (canceled || filePaths.length === 0) {
    return null;
  } else {
    return filePaths[0];
  }
}

function getPath(type: string) {
  switch (type) {
    case "appData":
      return app.getPath("appData");
    case "userData":
      return app.getPath("userData");
    case "logs":
      return app.getPath("logs");
    case "appResources":
      return process.resourcesPath;
  }
  return "";
}

let beatmapDownloadService: BeatmapDownloadService | undefined;

function getBeatmapDownloadService(): BeatmapDownloadService {
  if (!beatmapDownloadService) {
    const mirrorClient = new BeatmapMirrorClient(`Rewind/${app.getVersion()}`);
    beatmapDownloadService = new BeatmapDownloadService({
      userDataPath: app.getPath("userData"),
      mirrorClient,
      emitProgress: (progress) => {
        windows.frontend?.webContents.send("onBeatmapDownloadProgress", progress);
      },
    });
  }
  return beatmapDownloadService;
}

export function setupEventListeners() {
  ipcMain.handle("getPath", (event, type) => getPath(type));
  ipcMain.handle("selectDirectory", (event, defaultPath) => userSelectDirectory(defaultPath));
  ipcMain.handle("selectFile", (event, defaultPath) => userSelectFile(defaultPath));
  ipcMain.handle("getPlatform", () => process.platform);
  ipcMain.handle("getAppVersion", () => app.getVersion());
  ipcMain.handle("reboot", () => {
    app.relaunch();
    app.quit();
  });

  ipcMain.handle("readOsr", async (event, filePath) => {
    const buffer = await readFile(filePath);
    const replay = await read(buffer);
    // osu!lazer replays contain the osu!lazer mods (with their settings) at the end
    return {
      ...replay,
      isLazerReplay: isLazerReplayVersion(replay.gameVersion),
      lazerScoreInfo: readLazerScoreInfo(buffer),
    };
  });

  ipcMain.handle("lookupBeatmapByMd5", async (event, md5: string) => {
    return getBeatmapDownloadService().lookupBeatmapByMd5(md5);
  });

  ipcMain.handle("downloadAndImportBeatmap", async (event, request: BeatmapDownloadRequest) => {
    return getBeatmapDownloadService().downloadAndImport(request);
  });

  ipcMain.handle("flushPendingLazerImports", async (event, lazerFolder: string) => {
    return getBeatmapDownloadService().flushPendingLazerImports(lazerFolder);
  });

  ipcMain.handle("getBeatmapCacheFolder", () => {
    return getBeatmapDownloadService().fallbackCacheFolder;
  });
}
