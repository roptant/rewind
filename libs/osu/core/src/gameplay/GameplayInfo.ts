/**
 * Shows the statistics
 */

import { GameState } from "./GameState";
import { HitObjectType, SliderCheckPointType } from "../hitobjects/Types";
import { MainHitObjectVerdict } from "./Verdicts";
import { Beatmap } from "../beatmap/Beatmap";
import { HitCircle } from "../hitobjects/HitCircle";
import { Slider } from "../hitobjects/Slider";
import { SliderCheckPoint } from "../hitobjects/SliderCheckPoint";

export interface GameplayInfo {
  accuracy: number;
  // osu!stable: 300, 100, 50, 0
  // osu!lazer:  300, 100, 50, 25, 10, 0 (or something like that, small ticks are from sliders and count towards acc)
  verdictCounts: number[];
  score: number;
  currentCombo: number;
  maxComboSoFar: number;
}

/** COMBO **/

interface ReplayComboInformation {
  currentCombo: number;
  maxComboSoFar: number;
}

type ReplayJudgementCounts = number[];

function updateComboInfo(combo: ReplayComboInformation, type: HitObjectType | SliderCheckPointType, hit: boolean) {
  let currentCombo = combo.currentCombo;
  switch (type) {
    case "HIT_CIRCLE":
    case "TICK":
    case "REPEAT":
    case "SPINNER":
      currentCombo = hit ? currentCombo + 1 : 0;
      break;

    case "LAST_LEGACY_TICK":
      // Slider ends do not break the combo, but they can increase them
      currentCombo += hit ? 1 : 0;
      break;

    case "SLIDER":
      // For sliders there is no combo update
      break;
  }

  return { currentCombo, maxComboSoFar: Math.max(combo.maxComboSoFar, currentCombo) };
}

/** ACC **/

/**
 * Returns a number between 0 and 1 using osu!stable accuracy logic.
 * Also returns undefined if there is no count
 *
 * @param count counts of 300, 100, 50, 0 (in this order)
 */
export function osuStableAccuracy(count: number[]): number | undefined {
  if (count.length !== 4) {
    return undefined;
  }
  const JudgementScores = [300, 100, 50, 0];

  let perfect = 0,
    actual = 0;
  for (let i = 0; i < count.length; i++) {
    actual += JudgementScores[i] * count[i];
    perfect += JudgementScores[0] * count[i];
  }

  if (perfect === 0) {
    return undefined;
  }

  return actual / perfect;
}

// Slider ticks (and repeats) and slider tails that were hit (and in total)
interface SliderTickCounts {
  ticksHit: number;
  ticks: number;
  tailsHit: number;
  tails: number;
}

/**
 * Returns a number between 0 and 1 using osu!lazer accuracy logic, where slider ticks (30) and tails (150) also count.
 * Also returns undefined if there is no count
 *
 * @param count counts of 300, 100, 50, 0 (in this order)
 * @param sliderTicks counts of the slider ticks and tails
 */
export function osuLazerAccuracy(count: number[], sliderTicks: SliderTickCounts): number | undefined {
  const [great, ok, meh, miss] = count;
  const actual = 300 * great + 100 * ok + 50 * meh + 30 * sliderTicks.ticksHit + 150 * sliderTicks.tailsHit;
  const perfect = 300 * (great + ok + meh + miss) + 30 * sliderTicks.ticks + 150 * sliderTicks.tails;
  return perfect === 0 ? undefined : actual / perfect;
}

/** SCORE **/

interface EvaluationOption {
  scoringSystem: "ScoreV1" | "ScoreV2";
  // maybe beatmap difficulty -> since they are required for score v1 calc

  // osu!lazer (without the Classic mod) judges slider heads like hit circles, while the sliders themselves are not
  // judged. The accuracy is then calculated with osu!lazer's logic.
  sliderHeadAccuracy: boolean;
}

//https://osu.ppy.sh/wiki/en/Score/ScoreV1

const defaultEvaluationOptions = {
  scoringSystem: "ScoreV1",
  sliderHeadAccuracy: false,
} as EvaluationOption;

type StableVerdictCount = Record<MainHitObjectVerdict, number>;

export const defaultGameplayInfo: GameplayInfo = Object.freeze({
  currentCombo: 0,
  maxComboSoFar: 0,
  verdictCounts: [0, 0, 0, 0],
  accuracy: 0,
  score: 0,
});

/**
 * Calculating: Count, Accuracy, Combo, MaxCombo
 * The one who is calling this has to make sure that slider heads are not considered in case they are using osu!stable
 * calculation.
 */
export class GameplayInfoEvaluator {
  options: EvaluationOption;
  judgedObjectsIndex: number;
  comboInfo: ReplayComboInformation;
  verdictCount: StableVerdictCount;
  sliderTickCounts: SliderTickCounts;

  constructor(private beatmap: Beatmap, options?: Partial<EvaluationOption>) {
    this.options = { ...defaultEvaluationOptions, ...options };
    this.comboInfo = { maxComboSoFar: 0, currentCombo: 0 };
    this.verdictCount = { MISS: 0, MEH: 0, GREAT: 0, OK: 0 };
    this.sliderTickCounts = { ticksHit: 0, ticks: 0, tailsHit: 0, tails: 0 };
    this.judgedObjectsIndex = 0;
    // TODO: Do some initialization for calculating ScoreV2 (like max score)
  }

  evaluateHitObject(hitObjectType: HitObjectType, verdict: MainHitObjectVerdict, isCounted: boolean) {
    this.comboInfo = updateComboInfo(this.comboInfo, hitObjectType, verdict !== "MISS");
    if (isCounted) {
      this.verdictCount[verdict] += 1;
    }
  }

  evaluateSliderCheckpoint(hitObjectType: SliderCheckPointType, hit: boolean) {
    this.comboInfo = updateComboInfo(this.comboInfo, hitObjectType, hit);
    if (hitObjectType === "LAST_LEGACY_TICK") {
      this.sliderTickCounts.tails += 1;
      this.sliderTickCounts.tailsHit += hit ? 1 : 0;
    } else {
      this.sliderTickCounts.ticks += 1;
      this.sliderTickCounts.ticksHit += hit ? 1 : 0;
    }
  }

  countAsArray() {
    return (["GREAT", "OK", "MEH", "MISS"] as const).map((v) => this.verdictCount[v]);
  }

  evaluateReplayState(replayState: GameState): GameplayInfo {
    // Assume something like seeking backwards happened at reevaluate
    if (this.judgedObjectsIndex >= replayState.judgedObjects.length + 1) {
      this.comboInfo = { maxComboSoFar: 0, currentCombo: 0 };
      this.verdictCount = { MISS: 0, MEH: 0, GREAT: 0, OK: 0 };
      this.sliderTickCounts = { ticksHit: 0, ticks: 0, tailsHit: 0, tails: 0 };
      this.judgedObjectsIndex = 0;
    }

    while (this.judgedObjectsIndex < replayState.judgedObjects.length) {
      const id = replayState.judgedObjects[this.judgedObjectsIndex++];
      const hitObject = this.beatmap.getHitObject(id);
      if (hitObject instanceof SliderCheckPoint) {
        const hit = replayState.checkPointVerdict[hitObject.id].hit;
        this.evaluateSliderCheckpoint(hitObject.type, hit);
      } else if (hitObject instanceof HitCircle) {
        const verdict = replayState.hitCircleVerdict[id].type;
        const isSliderHead = hitObject.sliderId !== undefined;
        this.evaluateHitObject(hitObject.type, verdict, !isSliderHead || this.options.sliderHeadAccuracy);
      } else if (hitObject instanceof Slider) {
        const verdict = replayState.sliderVerdict[hitObject.id];
        this.evaluateHitObject(hitObject.type, verdict, !this.options.sliderHeadAccuracy);
      } else {
        // Spinner
        // TODO: We just going to assume that they hit it
        this.evaluateHitObject("SPINNER", "GREAT", true);
      }
    }

    const counts = this.countAsArray();
    const accuracy = this.options.sliderHeadAccuracy
      ? osuLazerAccuracy(counts, this.sliderTickCounts)
      : osuStableAccuracy(counts);
    return {
      score: 0,
      verdictCounts: counts,
      accuracy: accuracy ?? 1.0,
      currentCombo: this.comboInfo.currentCombo,
      maxComboSoFar: this.comboInfo.maxComboSoFar,
    };
  }
}
