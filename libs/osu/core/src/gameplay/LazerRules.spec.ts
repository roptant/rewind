import { parseBlueprint } from "../blueprint/BlueprintParser";
import { buildBeatmap } from "../beatmap/BeatmapBuilder";
import { OsuAction, ReplayFrame } from "../replays/Replay";
import { BucketedGameStateTimeMachine } from "./GameStateTimeMachine";
import { GameStateEvaluatorOptions, NoteLockStyle } from "./GameStateEvaluator";
import { GameplayInfoEvaluator, osuLazerAccuracy } from "./GameplayInfo";
import { Position } from "@osujs/math";

// OD 8: the hit windows are 31ms (300), 75ms (100), 119ms (50)
const blueprint = (hitObjects: string) =>
  parseBlueprint(`osu file format v14

[General]
StackLeniency: 0.7

[Difficulty]
HPDrainRate:5
CircleSize:4
OverallDifficulty:8
ApproachRate:9
SliderMultiplier:1.4
SliderTickRate:1

[TimingPoints]
0,500,4,2,0,100,1,0

[HitObjects]
${hitObjects}
`);

const frame = (time: number, position: Position, pressing = false): ReplayFrame => ({
  time,
  position,
  actions: pressing ? [OsuAction.leftButton] : [],
});

function simulate(hitObjects: string, frames: ReplayFrame[], options: GameStateEvaluatorOptions) {
  const beatmap = buildBeatmap(blueprint(hitObjects), { mods: [] });
  const state = new BucketedGameStateTimeMachine(frames, beatmap, options).gameStateAt(1e9);
  return { beatmap, state };
}

describe("note lock", () => {
  const circles = `100,100,1000,1,0,0:0:0:0:\n400,300,1100,1,0,0:0:0:0:`;
  const second = { x: 400, y: 300 };
  // Clicks on the second circle at the given time while the first one has not been hit yet
  const clickSecondCircleAt = (time: number, noteLockStyle: NoteLockStyle) =>
    simulate(
      circles,
      // The simulation only runs until the last frame
      [frame(0, { x: 0, y: 0 }), frame(time, second, true), frame(time + 20, second), frame(3000, second)],
      { hitWindowStyle: "OSU_STABLE", noteLockStyle },
    ).state;

  it("osu!lazer allows hitting a later circle once the earlier circle's time has passed", () => {
    const state = clickSecondCircleAt(1050, "LAZER");
    expect(state.hitCircleVerdict["1"]).toEqual({ judgementTime: 1050, type: "OK" });
    expect(state.hitCircleVerdict["0"]).toEqual({
      judgementTime: 1050,
      type: "MISS",
      missReason: "FORCE_MISS_NOTELOCK",
    });
    // The force miss is judged before the hit (relevant for the combo)
    expect(state.judgedObjects).toEqual(["0", "1"]);
  });

  it("osu!lazer blocks hitting a later circle before the earlier circle's time", () => {
    const state = clickSecondCircleAt(990, "LAZER");
    expect(state.hitCircleVerdict["1"]).toMatchObject({ type: "MISS", missReason: "TIME_EXPIRED" });
    expect(state.hitCircleVerdict["0"]).toMatchObject({ type: "MISS", missReason: "TIME_EXPIRED" });
  });

  it("osu!stable blocks hitting a later circle as long as the earlier circle can be hit", () => {
    const state = clickSecondCircleAt(1050, "STABLE");
    expect(state.hitCircleVerdict["1"]).toMatchObject({ type: "MISS", missReason: "TIME_EXPIRED" });
    expect(state.hitCircleVerdict["0"]).toMatchObject({ type: "MISS", missReason: "TIME_EXPIRED" });
  });
});

describe("slider head accuracy", () => {
  // A slider from (100, 100) to (200, 100) that lasts 357ms, its head is hit 50ms late and then followed perfectly
  const slider = "100,100,2000,2,0,L|200:100,1,100";
  const frames = [frame(0, { x: 0, y: 0 })];
  for (let time = 2050; time <= 2450; time += 10) {
    const progress = Math.min(1, (time - 2000) / 357);
    frames.push(frame(time, { x: 100 + 100 * progress, y: 100 }, time < 2400));
  }
  const { beatmap, state } = simulate(slider, frames, { hitWindowStyle: "OSU_STABLE", noteLockStyle: "STABLE" });

  it("osu!stable judges the slider based on the hit checkpoints", () => {
    const info = new GameplayInfoEvaluator(beatmap, {}).evaluateReplayState(state);
    expect(info.verdictCounts).toEqual([1, 0, 0, 0]);
    expect(info.accuracy).toEqual(1);
  });

  it("osu!lazer judges the slider head like a hit circle", () => {
    const evaluator = new GameplayInfoEvaluator(beatmap, { sliderHeadAccuracy: true });
    const info = evaluator.evaluateReplayState(state);
    expect(info.verdictCounts).toEqual([0, 1, 0, 0]);
    // 100 for the head and 150 for the slider tail
    expect(evaluator.sliderTickCounts).toEqual({ ticksHit: 0, ticks: 0, tailsHit: 1, tails: 1 });
    expect(info.accuracy).toBeCloseTo(250 / 450);
  });
});

describe("osuLazerAccuracy", () => {
  it("includes the slider ticks and tails", () => {
    const ticks = { ticksHit: 9, ticks: 10, tailsHit: 4, tails: 5 };
    // 300 * 3 + 100 + 30 * 9 + 150 * 4 = 1870 out of 300 * 5 + 30 * 10 + 150 * 5 = 2550
    expect(osuLazerAccuracy([3, 1, 0, 1], ticks)).toBeCloseTo(1870 / 2550);
    expect(osuLazerAccuracy([0, 0, 0, 0], { ticksHit: 0, ticks: 0, tailsHit: 0, tails: 0 })).toBeUndefined();
  });
});
