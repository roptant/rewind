import { BeatmapDifficulty } from "../beatmap/BeatmapDifficulty";
import { BeatmapDifficultyAdjuster } from "./Mods";
import { OsuHitObject } from "../hitobjects/Types";
import { MirrorMod } from "./MirrorMod";

export class HardRockMod {
  static difficultyAdjuster: BeatmapDifficultyAdjuster = (base: BeatmapDifficulty): BeatmapDifficulty => ({
    ...base, // SliderDiffs
    overallDifficulty: Math.min(10, base.overallDifficulty * 1.4),
    approachRate: Math.min(10, base.approachRate * 1.4),
    drainRate: Math.min(10, base.drainRate * 1.4),
    circleSize: Math.min(10, base.circleSize * 1.3),
  });

  static flipVertically = (hitObjects: OsuHitObject[]) => MirrorMod.reflect(hitObjects, "VERTICAL");
}
