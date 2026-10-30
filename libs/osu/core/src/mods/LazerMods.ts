import { BeatmapDifficulty } from "../beatmap/BeatmapDifficulty";
import { MirrorReflection } from "./MirrorMod";

/**
 * A mod as it is stored by osu!lazer (e.g. at the end of the exported .osr files), for example:
 * `{ "acronym": "DT", "settings": { "speed_change": 1.2 } }`
 *
 * The legacy mods bitmask of a replay does not contain the osu!lazer only mods (e.g. Mirror) and their settings.
 */
export interface LazerMod {
  acronym: string;
  settings?: Record<string, unknown>;
}

export interface LazerModSettings {
  // Rate adjusting mods can have a custom speed (e.g. DT with 1.2x)
  clockRate?: number;
  mirror?: MirrorReflection;
  difficultyOverrides: Partial<BeatmapDifficulty>;
  // Without the Classic mod osu!lazer uses its own note lock and judges the slider heads like hit circles
  classicNoteLock: boolean;
  sliderHeadAccuracy: boolean;
  // Mods that change the positions of the hit objects, the speed during the play or the judgements in a way that is
  // not supported, therefore the analysis will not be correct.
  unsupportedMods: string[];
}

const DEFAULT_SPEED_CHANGE: Record<string, number> = { DT: 1.5, NC: 1.5, HT: 0.75, DC: 0.75 };

const MIRROR_REFLECTIONS: MirrorReflection[] = ["HORIZONTAL", "VERTICAL", "BOTH"];

// Difficulty Adjust settings
const DIFFICULTY_SETTINGS: Record<string, keyof BeatmapDifficulty> = {
  circle_size: "circleSize",
  approach_rate: "approachRate",
  overall_difficulty: "overallDifficulty",
  drain_rate: "drainRate",
};

// Random, Transform, Wiggle, Magnetised, Repel, Wind Up, Wind Down, Adaptive Speed, Target Practice, Strict Tracking
const UNSUPPORTED_MODS = ["RD", "TR", "WG", "MG", "RP", "WU", "WD", "AS", "TP", "ST"];

function setting<T>(mod: LazerMod, name: string, defaultValue: T): T {
  const value = mod.settings?.[name];
  return value === undefined || value === null ? defaultValue : (value as T);
}

function mirrorReflection(value: unknown): MirrorReflection {
  // Stored as the index of osu!lazer's `MirrorType` enum (Horizontal, Vertical, Both)
  if (typeof value === "number") return MIRROR_REFLECTIONS[value] ?? "HORIZONTAL";
  if (typeof value === "string") {
    return MIRROR_REFLECTIONS.find((r) => r === value.toUpperCase()) ?? "HORIZONTAL";
  }
  return "HORIZONTAL";
}

/**
 * Determines how the osu!lazer mods affect the beatmap and the gameplay.
 */
export function lazerModSettings(mods: LazerMod[]): LazerModSettings {
  const result: LazerModSettings = {
    difficultyOverrides: {},
    classicNoteLock: false,
    sliderHeadAccuracy: true,
    unsupportedMods: [],
  };
  for (const mod of mods) {
    const { acronym } = mod;
    if (acronym in DEFAULT_SPEED_CHANGE) {
      result.clockRate = setting(mod, "speed_change", DEFAULT_SPEED_CHANGE[acronym]);
    } else if (acronym === "MR") {
      result.mirror = mirrorReflection(mod.settings?.["reflection"]);
    } else if (acronym === "DA") {
      for (const [name, key] of Object.entries(DIFFICULTY_SETTINGS)) {
        const value = mod.settings?.[name];
        if (typeof value === "number") result.difficultyOverrides[key] = value;
      }
    } else if (acronym === "CL") {
      result.classicNoteLock = setting(mod, "classic_note_lock", true);
      result.sliderHeadAccuracy = !setting(mod, "no_slider_head_accuracy", true);
    } else if (UNSUPPORTED_MODS.includes(acronym)) {
      result.unsupportedMods.push(acronym);
    }
  }
  return result;
}
