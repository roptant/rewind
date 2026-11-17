import { injectable } from "inversify";
import { BehaviorSubject } from "rxjs";
import { Beatmap, buildBeatmap, lazerModSettings, modsToBitmask, parseBlueprint } from "@osujs/core";
import { Texture } from "pixi.js";
import { GameSimulator } from "../common/game/GameSimulator";
import { AudioService } from "../common/audio/AudioService";
import { ReplayService } from "../common/local/ReplayService";
import { BeatmapManager } from "./BeatmapManager";
import { ReplayManager } from "./ReplayManager";
import { AnalysisSceneKeys, AnalysisSceneManager } from "./AnalysisSceneManager";
import { AudioEngine } from "../common/audio/AudioEngine";
import { GameplayClock } from "../common/game/GameplayClock";
import { GameLoop } from "../common/game/GameLoop";
import { PixiRendererManager } from "../renderers/PixiRendererManager";
import { readFile } from "fs/promises";
import { BlueprintLocatorService } from "../common/local/BlueprintLocatorService";
import { BeatmapBackgroundSettingsStore } from "../common/beatmap-background";
import { TextureManager } from "../textures/TextureManager";
import { ReplayFileWatcher } from "../common/local/ReplayFileWatcher";
import { ModSettingsService } from "../analysis/mod-settings";
import { BeatmapDownloadSettingsStore } from "../common/beatmap-download";
import { OsuClient, OsuFolderService } from "../common/local/OsuFolderService";
import {
  BeatmapDownloadProgressEvent,
  BeatmapDownloadResult,
  BeatmapImportTarget,
  frontendAPI,
  RemoteBeatmapMetadata,
} from "../../api";

export interface MissingBeatmapInfo {
  replayId: string;
  md5: string;
  replayClient: OsuClient;
  metadata?: RemoteBeatmapMetadata;
}

export interface Scenario {
  status: "LOADING" | "DOWNLOADING" | "MISSING_BEATMAP" | "ERROR" | "DONE" | "INIT";
  // Only set if the status is "ERROR"
  error?: string;
  // Something the user should be aware of, even though the replay could be loaded
  warning?: string;
  // Set while status is "DOWNLOADING"
  download?: BeatmapDownloadProgressEvent;
  // Set when status is "MISSING_BEATMAP" (if auto-download is disabled)
  missingBeatmap?: MissingBeatmapInfo;
}

function localFile(path: string) {
  return `file://${path}`;
}

@injectable()
export class ScenarioManager {
  public scenario$: BehaviorSubject<Scenario>;

  constructor(
    private readonly gameClock: GameplayClock,
    private readonly renderer: PixiRendererManager,
    private readonly gameLoop: GameLoop,
    private readonly gameSimulator: GameSimulator,
    private readonly modSettingsService: ModSettingsService,
    private readonly blueprintLocatorService: BlueprintLocatorService,
    private readonly osuFolderService: OsuFolderService,
    private readonly beatmapDownloadSettingsStore: BeatmapDownloadSettingsStore,
    private readonly audioService: AudioService,
    private readonly textureManager: TextureManager,
    private readonly replayService: ReplayService,
    private readonly beatmapBackgroundSettingsStore: BeatmapBackgroundSettingsStore,
    private readonly beatmapManager: BeatmapManager,
    private readonly replayManager: ReplayManager,
    private readonly sceneManager: AnalysisSceneManager,
    private readonly replayWatcher: ReplayFileWatcher,
    private readonly audioEngine: AudioEngine,
  ) {
    this.scenario$ = new BehaviorSubject<Scenario>({ status: "INIT" });
  }

  public initialize() {
    this.replayWatcher.newReplays$.subscribe((replayId) => {
      void this.loadReplay(replayId);
    });
  }

  // This is a temporary solution to
  async clearReplay() {
    this.gameClock.clear();
    this.replayManager.setMainReplay(null);
    this.audioEngine.destroy();
    this.renderer.getRenderer()?.clear();
    this.beatmapManager.setBeatmap(Beatmap.EMPTY_BEATMAP);
    this.gameSimulator.clear();
    this.gameLoop.stopTicker();
    // await this.sceneManager.changeToScene(AnalysisSceneKeys.IDLE);
    this.scenario$.next({ status: "INIT" });
  }

  async loadReplay(replayId: string, options?: { forceDownload?: boolean; targetOverride?: BeatmapImportTarget }) {
    try {
      await this.loadReplayOrThrow(replayId, options);
    } catch (err) {
      console.error(`Could not load the replay with id = ${replayId}`, err);
      this.scenario$.next({ status: "ERROR", error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async downloadMissingBeatmap(
    md5: string,
    replayClient: OsuClient,
    targetOverride?: BeatmapImportTarget,
  ): Promise<BeatmapDownloadResult> {
    const cleanMd5 = md5.toLowerCase();
    const downloadSettings = this.beatmapDownloadSettingsStore.settings;

    this.scenario$.next({
      status: "DOWNLOADING",
      download: { md5: cleanMd5, stage: "resolving" },
    });

    const unsubscribe = frontendAPI.onBeatmapDownloadProgress((progress) => {
      if (progress.md5.toLowerCase() === cleanMd5) {
        this.scenario$.next({
          status: "DOWNLOADING",
          download: progress,
        });
      }
    });

    try {
      const result = await frontendAPI.downloadAndImportBeatmap({
        md5: cleanMd5,
        replayClient,
        preferredTarget: targetOverride ?? downloadSettings.preferredTarget,
        preferredMirror: downloadSettings.preferredMirror,
        noVideo: downloadSettings.noVideo,
        stableSongsFolder: this.osuFolderService.songsFolder$.getValue() || undefined,
        lazerFolder: this.osuFolderService.getLazerFolder(),
      });
      this.blueprintLocatorService.markBlueprintImported(result.importedTo);
      return result;
    } finally {
      unsubscribe();
    }
  }

  private async loadReplayOrThrow(
    replayId: string,
    options?: { forceDownload?: boolean; targetOverride?: BeatmapImportTarget },
  ) {
    console.log(`ScenarioManager loading replay with id = ${replayId}`);
    // TODO: Clean this up
    this.audioEngine.destroy();

    this.scenario$.next({ status: "LOADING" });

    const replay = await this.replayService.retrieveReplay(replayId);
    // The beatmap is looked up in both osu! installations, but preferably in the one the replay was played on
    let blueprintInfo = await this.blueprintLocatorService.getBlueprintByMD5(replay.beatmapMd5, replay.client);
    let importWarning: string | undefined;

    if (!blueprintInfo) {
      const shouldDownload = options?.forceDownload || this.beatmapDownloadSettingsStore.settings.autoDownload;
      if (!shouldDownload) {
        const metadata = await frontendAPI.lookupBeatmapByMd5(replay.beatmapMd5).catch(() => undefined);
        this.scenario$.next({
          status: "MISSING_BEATMAP",
          missingBeatmap: {
            replayId,
            md5: replay.beatmapMd5,
            replayClient: replay.client,
            metadata,
          },
        });
        return;
      }

      const downloadResult = await this.downloadMissingBeatmap(
        replay.beatmapMd5,
        replay.client,
        options?.targetOverride,
      );
      importWarning = downloadResult.warning;
      this.scenario$.next({ status: "LOADING" });

      const lookupPreference: OsuClient = downloadResult.importedTo === "lazer" ? "lazer" : "stable";
      blueprintInfo = await this.blueprintLocatorService.getBlueprintByMD5(replay.beatmapMd5, lookupPreference);
      if (!blueprintInfo) {
        throw Error(
          `Downloaded beatmap (MD5=${replay.beatmapMd5}) into ${downloadResult.importedTo}, but Rewind still could not locate it.`,
        );
      }
    }
    console.log(`Replay played on osu!${replay.client}, beatmap found in ${blueprintInfo.client}`);

    const resolveFile = (fileName: string) => this.blueprintLocatorService.resolveFilePath(blueprintInfo!, fileName);

    const osuFilePath = resolveFile(blueprintInfo.osuFileName);
    if (!osuFilePath) throw Error(`Could not find the .osu file of the blueprint with MD5=${replay.beatmapMd5}`);

    const rawBlueprint = await readFile(osuFilePath, "utf-8");
    const blueprint = parseBlueprint(rawBlueprint);

    const { metadata } = blueprint.blueprintInfo;

    // Load background
    const backgroundFilePath = resolveFile(metadata.backgroundFile);
    this.beatmapBackgroundSettingsStore.texture$.next(
      backgroundFilePath ? await this.textureManager.loadTexture(localFile(backgroundFilePath)) : Texture.EMPTY,
    );

    // Load audio
    const audioFilePath = resolveFile(metadata.audioFile);
    if (!audioFilePath) throw Error(`Could not find the audio file '${metadata.audioFile}' of the blueprint`);
    this.audioEngine.setSong(await this.audioService.loadAudio(localFile(audioFilePath)));
    this.audioEngine.song?.mediaElement.addEventListener("loadedmetadata", () => {
      const duration = (this.audioEngine.song?.mediaElement.duration ?? 0) * 1000;
      this.gameClock.setDuration(duration);
      this.gameSimulator.calculateDifficulties(rawBlueprint, duration, modsToBitmask(replay.mods));
    });

    // If the building is too slow or unbearable, we should push the building to a WebWorker, but right now it's ok
    // even on long maps.
    const lazerMods = replay.lazerMods ? lazerModSettings(replay.lazerMods) : undefined;
    const beatmap = buildBeatmap(blueprint, {
      addStacking: true,
      mods: replay.mods,
      clockRate: lazerMods?.clockRate,
      mirror: lazerMods?.mirror,
      difficultyOverrides: lazerMods?.difficultyOverrides,
    });

    console.log(`Beatmap built with ${beatmap.hitObjects.length} hitobjects`);
    console.log(`Replay loaded with ${replay.frames.length} frames`);
    const modHidden = replay.mods.includes("HIDDEN");
    const initialSpeed = beatmap.gameClockRate;

    this.modSettingsService.setHidden(modHidden);
    // Not supported yet
    this.modSettingsService.setFlashlight(false);

    this.gameClock.pause();
    this.gameClock.setSpeed(initialSpeed);
    this.gameClock.seekTo(0);
    this.beatmapManager.setBeatmap(beatmap);
    this.replayManager.setMainReplay(replay);

    await this.gameSimulator.simulateReplay(beatmap, replay);
    await this.sceneManager.changeToScene(AnalysisSceneKeys.ANALYSIS);

    this.gameLoop.startTicker();
    const unsupportedMods = lazerMods?.unsupportedMods ?? [];
    const warnings = [
      unsupportedMods.length > 0
        ? `The osu!lazer mods ${unsupportedMods.join(", ")} are not supported, the analysis might not match the play.`
        : undefined,
      importWarning,
    ].filter(Boolean);

    this.scenario$.next({
      status: "DONE",
      warning: warnings.length > 0 ? warnings.join(" ") : undefined,
    });
  }

  // This is just the NM view of a beatmap
  async loadBeatmap(blueprintId: string) {
    // Set speed to 1.0
    this.gameClock.setSpeed(1.0);
    this.gameClock.seekTo(0);
    this.modSettingsService.setHidden(false);
    this.replayManager.setMainReplay(null);
  }

  async addSubReplay() {
    // Only possible if `mainReplay` is loaded
    // Adjust y-flip according to `mainReplay`
  }
}
