import { lazerModSettings } from "./LazerMods";
import { parseBlueprint } from "../blueprint/BlueprintParser";
import { buildBeatmap } from "../beatmap/BeatmapBuilder";
import { HitCircle } from "../hitobjects/HitCircle";

describe("lazerModSettings", () => {
  it("uses osu!lazer's rules without the Classic mod", () => {
    expect(lazerModSettings([])).toEqual({
      difficultyOverrides: {},
      classicNoteLock: false,
      sliderHeadAccuracy: true,
      unsupportedMods: [],
    });
  });

  it("reads the speed of the rate adjusting mods", () => {
    expect(lazerModSettings([{ acronym: "DT" }]).clockRate).toEqual(1.5);
    expect(lazerModSettings([{ acronym: "DT", settings: { speed_change: 1.19 } }]).clockRate).toEqual(1.19);
    expect(lazerModSettings([{ acronym: "NC", settings: { speed_change: 1.3 } }]).clockRate).toEqual(1.3);
    expect(lazerModSettings([{ acronym: "HT" }]).clockRate).toEqual(0.75);
    expect(lazerModSettings([{ acronym: "DC", settings: { speed_change: 0.6 } }]).clockRate).toEqual(0.6);
    expect(lazerModSettings([{ acronym: "HD" }]).clockRate).toBeUndefined();
  });

  it("reads the axes of the Mirror mod", () => {
    expect(lazerModSettings([{ acronym: "MR" }]).mirror).toEqual("HORIZONTAL");
    expect(lazerModSettings([{ acronym: "MR", settings: { reflection: 1 } }]).mirror).toEqual("VERTICAL");
    expect(lazerModSettings([{ acronym: "MR", settings: { reflection: 2 } }]).mirror).toEqual("BOTH");
  });

  it("reads the overridden difficulty of Difficulty Adjust", () => {
    const settings = lazerModSettings([
      { acronym: "DA", settings: { circle_size: 3.5, approach_rate: 10.5, extended_limits: true } },
    ]);
    expect(settings.difficultyOverrides).toEqual({ circleSize: 3.5, approachRate: 10.5 });
  });

  it("uses the classic rules with the Classic mod", () => {
    expect(lazerModSettings([{ acronym: "CL" }])).toMatchObject({ classicNoteLock: true, sliderHeadAccuracy: false });
    const customized = lazerModSettings([
      { acronym: "CL", settings: { classic_note_lock: false, no_slider_head_accuracy: false } },
    ]);
    expect(customized).toMatchObject({ classicNoteLock: false, sliderHeadAccuracy: true });
  });

  it("lists the mods that are not supported", () => {
    const mods = [{ acronym: "HD" }, { acronym: "RD" }, { acronym: "WG" }, { acronym: "TC" }];
    expect(lazerModSettings(mods).unsupportedMods).toEqual(["RD", "WG"]);
  });
});

describe("buildBeatmap with osu!lazer mods", () => {
  const blueprint = parseBlueprint(`osu file format v14

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
100,50,1000,1,0,0:0:0:0:
`);
  const position = (mirror?: "HORIZONTAL" | "VERTICAL" | "BOTH") =>
    (buildBeatmap(blueprint, { mods: [], mirror }).hitObjects[0] as HitCircle).position;

  it("mirrors the hit objects", () => {
    expect(position()).toEqual({ x: 100, y: 50 });
    expect(position("HORIZONTAL")).toEqual({ x: 412, y: 50 });
    expect(position("VERTICAL")).toEqual({ x: 100, y: 334 });
    expect(position("BOTH")).toEqual({ x: 412, y: 334 });
  });

  it("uses the custom clock rate and the overridden difficulty", () => {
    expect(buildBeatmap(blueprint, { mods: ["DOUBLE_TIME"] }).gameClockRate).toEqual(1.5);
    expect(buildBeatmap(blueprint, { mods: ["DOUBLE_TIME"], clockRate: 1.2 }).gameClockRate).toEqual(1.2);

    const beatmap = buildBeatmap(blueprint, { mods: [], difficultyOverrides: { circleSize: 7 } });
    expect(beatmap.difficulty).toMatchObject({ circleSize: 7, overallDifficulty: 8, approachRate: 9 });
  });
});
