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

export interface Scenario {
  status: "LOADING" | "ERROR" | "DONE" | "INIT";
  // Only set if the status is "ERROR"
  error?: string;
  // Something the user should be aware of, even though the replay could be loaded
  warning?: string;
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

  async loadReplay(replayId: string) {
    try {
      await this.loadReplayOrThrow(replayId);
    } catch (err) {
      console.error(`Could not load the replay with id = ${replayId}`, err);
      this.scenario$.next({ status: "ERROR", error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async loadReplayOrThrow(replayId: string) {
    console.log(`ScenarioManager loading replay with id = ${replayId}`);
    // TODO: Clean this up
    this.audioEngine.destroy();

    this.scenario$.next({ status: "LOADING" });

    const replay = await this.replayService.retrieveReplay(replayId);
    const blueprintInfo = await this.blueprintLocatorService.getBlueprintByMD5(replay.beatmapMd5);
    if (!blueprintInfo) {
      throw Error(`Could not find the beatmap of the replay (MD5=${replay.beatmapMd5}). Is it imported in osu!?`);
    }

    const resolveFile = (fileName: string) => this.blueprintLocatorService.resolveFilePath(blueprintInfo, fileName);

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
    this.scenario$.next({
      status: "DONE",
      warning:
        unsupportedMods.length > 0
          ? `The osu!lazer mods ${unsupportedMods.join(", ")} are not supported, the analysis might not match the play.`
          : undefined,
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
