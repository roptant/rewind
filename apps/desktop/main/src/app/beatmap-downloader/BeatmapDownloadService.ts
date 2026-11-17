import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { BeatmapMirrorClient } from "./BeatmapMirrorClient";
import { importOszToLazerOffline, isLazerRealmLocked, LazerRealmLockedError } from "./LazerRealmImporter";
import { ParsedOszArchive, parseOszArchive } from "./OszArchive";
import { importOszToFolder } from "./StableBeatmapImporter";
import {
  BeatmapDownloadProgressEvent,
  BeatmapDownloadRequest,
  BeatmapDownloadResult,
  RemoteBeatmapMetadata,
} from "./types";

export interface BeatmapDownloadServiceDeps {
  userDataPath: string;
  mirrorClient: BeatmapMirrorClient;
  emitProgress?: (event: BeatmapDownloadProgressEvent) => void;
}

export class BeatmapDownloadService {
  private readonly inFlight = new Map<string, Promise<BeatmapDownloadResult>>();

  constructor(private readonly deps: BeatmapDownloadServiceDeps) {}

  get fallbackCacheFolder(): string {
    return join(this.deps.userDataPath, "beatmaps");
  }

  get pendingLazerQueueFolder(): string {
    return join(this.deps.userDataPath, "pending-lazer-imports");
  }

  async lookupBeatmapByMd5(md5: string): Promise<RemoteBeatmapMetadata> {
    return this.deps.mirrorClient.lookupByMd5(md5);
  }

  async downloadAndImport(request: BeatmapDownloadRequest): Promise<BeatmapDownloadResult> {
    const cleanMd5 = request.md5.trim().toLowerCase();
    const existing = this.inFlight.get(cleanMd5);
    if (existing) {
      return existing;
    }

    const task = this.executeDownloadAndImport({ ...request, md5: cleanMd5 }).finally(() => {
      this.inFlight.delete(cleanMd5);
    });
    this.inFlight.set(cleanMd5, task);
    return task;
  }

  private async executeDownloadAndImport(request: BeatmapDownloadRequest): Promise<BeatmapDownloadResult> {
    const { md5 } = request;
    this.deps.emitProgress?.({ md5, stage: "resolving" });

    const metadata = await this.deps.mirrorClient.lookupByMd5(md5);

    this.deps.emitProgress?.({
      md5,
      stage: "downloading",
      title: metadata.title,
      artist: metadata.artist,
      difficultyName: metadata.difficultyName,
      transferredBytes: 0,
    });

    let parsedArchive: ParsedOszArchive | undefined;
    const { buffer } = await this.deps.mirrorClient.downloadOsz(metadata.beatmapSetId, {
      preferredMirror: request.preferredMirror,
      noVideo: request.noVideo,
      validateArchive: (buf) => {
        parsedArchive = parseOszArchive(buf);
      },
      onMirrorProgress: (mirrorName, transferredBytes, totalBytes) => {
        this.deps.emitProgress?.({
          md5,
          stage: "downloading",
          title: metadata.title,
          artist: metadata.artist,
          difficultyName: metadata.difficultyName,
          mirror: mirrorName,
          transferredBytes,
          totalBytes,
        });
      },
    });

    const archive = parsedArchive ?? parseOszArchive(buffer);
    const hasTargetDifficulty = archive.difficulties.some((d) => d.md5Hash === md5);
    if (!hasTargetDifficulty) {
      throw new Error(
        `Downloaded "${metadata.artist} - ${metadata.title}" (#${metadata.beatmapSetId}), but its .osu files were updated since this replay was recorded (MD5=${md5} not in archive).`,
      );
    }

    this.deps.emitProgress?.({
      md5,
      stage: "importing",
      title: metadata.title,
      artist: metadata.artist,
      difficultyName: metadata.difficultyName,
    });

    const targetOrder = this.determineTargetOrder(request);

    for (const target of targetOrder) {
      if (target === "lazer" && request.lazerFolder) {
        try {
          await importOszToLazerOffline(archive, request.lazerFolder, {
            targetMd5: md5,
            onlineMetadata: metadata,
          });
          return {
            importedTo: "lazer",
            metadata,
          };
        } catch (err) {
          if (err instanceof LazerRealmLockedError) {
            await this.queuePendingLazerOsz(metadata.beatmapSetId, buffer, metadata);
            if (request.stableSongsFolder) {
              const folderName = await importOszToFolder(archive, request.stableSongsFolder, metadata.beatmapSetId);
              return {
                importedTo: "stable",
                folderName,
                metadata,
                warning:
                  "osu!lazer is currently running (client.realm is locked), so the beatmap was imported into osu!stable and queued for offline osu!lazer import.",
              };
            }
            const folderName = await importOszToFolder(archive, this.fallbackCacheFolder, metadata.beatmapSetId);
            return {
              importedTo: "cache",
              folderName,
              metadata,
              warning:
                "osu!lazer is currently running (client.realm is locked). Loaded from Rewind's cache and queued for offline osu!lazer import once osu!lazer is closed.",
            };
          }
          throw err;
        }
      }

      if (target === "stable" && request.stableSongsFolder) {
        const folderName = await importOszToFolder(archive, request.stableSongsFolder, metadata.beatmapSetId);
        return {
          importedTo: "stable",
          folderName,
          metadata,
        };
      }
    }

    const folderName = await importOszToFolder(archive, this.fallbackCacheFolder, metadata.beatmapSetId);
    return {
      importedTo: "cache",
      folderName,
      metadata,
    };
  }

  private determineTargetOrder(request: BeatmapDownloadRequest): Array<"lazer" | "stable"> {
    const hasLazer = Boolean(request.lazerFolder);
    const hasStable = Boolean(request.stableSongsFolder);

    if (request.preferredTarget === "lazer") {
      return [hasLazer && "lazer", hasStable && "stable"].filter((x): x is "lazer" | "stable" => Boolean(x));
    }
    if (request.preferredTarget === "stable") {
      return [hasStable && "stable", hasLazer && "lazer"].filter((x): x is "lazer" | "stable" => Boolean(x));
    }
    // "auto": match the replay's client first when available
    if (request.replayClient === "lazer") {
      return [hasLazer && "lazer", hasStable && "stable"].filter((x): x is "lazer" | "stable" => Boolean(x));
    }
    return [hasStable && "stable", hasLazer && "lazer"].filter((x): x is "lazer" | "stable" => Boolean(x));
  }

  private async queuePendingLazerOsz(
    beatmapSetId: number,
    oszBuffer: Buffer,
    metadata: RemoteBeatmapMetadata,
  ): Promise<void> {
    try {
      await mkdir(this.pendingLazerQueueFolder, { recursive: true });
      const base = join(this.pendingLazerQueueFolder, String(beatmapSetId));
      await writeFile(`${base}.osz`, oszBuffer);
      await writeFile(`${base}.json`, JSON.stringify(metadata), "utf-8");
    } catch (err) {
      console.warn("Could not queue beatmap for pending offline osu!lazer import", err);
    }
  }

  /**
   * Imports any queued `.osz` archives into `client.realm` once `osu!lazer` is closed.
   */
  async flushPendingLazerImports(lazerFolder: string): Promise<number> {
    if (!lazerFolder) return 0;
    let entries: string[];
    try {
      entries = await readdir(this.pendingLazerQueueFolder);
    } catch {
      return 0;
    }

    const oszFiles = entries.filter((f) => f.endsWith(".osz"));
    if (oszFiles.length === 0) return 0;

    if (await isLazerRealmLocked(lazerFolder)) {
      return 0;
    }

    let importedCount = 0;
    for (const oszFile of oszFiles) {
      const oszPath = join(this.pendingLazerQueueFolder, oszFile);
      const metaPath = oszPath.replace(/\.osz$/, ".json");
      try {
        const buf = await readFile(oszPath);
        const archive = parseOszArchive(buf);
        let onlineMetadata: RemoteBeatmapMetadata | undefined;
        try {
          onlineMetadata = JSON.parse(await readFile(metaPath, "utf-8")) as RemoteBeatmapMetadata;
        } catch {
          onlineMetadata = undefined;
        }
        await importOszToLazerOffline(archive, lazerFolder, { onlineMetadata });
        await unlink(oszPath).catch(() => undefined);
        await unlink(metaPath).catch(() => undefined);
        importedCount++;
      } catch (err) {
        if (err instanceof LazerRealmLockedError) {
          break;
        }
        console.error(`Failed to flush pending osu!lazer import ${oszFile}`, err);
      }
    }
    return importedCount;
  }
}
