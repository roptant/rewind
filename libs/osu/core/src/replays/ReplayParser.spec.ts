import { OsuAction, ReplayFrame } from "./Replay";
import { parseReplayFramesFromRaw } from "./ReplayParser";

// w, x, y, z
// w time since last action
// x, y coordinates
// z bitmask of what was pressed
describe("Parsing rawReplayData (from node-osr)", function () {
  it("should ignore the first three frames from legacy due to negative", function () {
    // From RyuK +HDDT Akatsuki Zukuyo replay
    const raw = "0|256|-500|0,-1|256|-500|0,-1171|257.0417|124.7764|1";
    const actual = parseReplayFramesFromRaw(raw);
    expect(actual).toStrictEqual([]);
  });
  it("should have the first correct frame", function () {
    // From RyuK +HDDT Akatsuki Zukuyo replay
    const raw = "0|256|-500|0,-1|256|-500|0,-1171|257.0417|124.7764|1,13|256.8854|124.8789|1";
    const f1: ReplayFrame = {
      time: -1171 - 1 + 13,
      position: { x: 256.8854, y: 124.8789 },
      actions: [OsuAction.leftButton],
    };
    const actual = parseReplayFramesFromRaw(raw);
    expect(actual).toEqual([f1]);
  });
  it("should parse the frames of replays exported by osu!lazer", function () {
    // osu!lazer doesn't write the two (256, -500) frames, its first frame can have a negative time (which is skipped
    // just like osu!lazer does it), the positions are floats and only Left1/Right1 are used as buttons.
    const raw = "-1800|100.5|200.25|0,16|101.75|201|1,16|102|202|2,16|103|203|3,-12345|0|0|1234";
    const actual = parseReplayFramesFromRaw(raw);
    expect(actual).toEqual([
      { time: -1784, position: { x: 101.75, y: 201 }, actions: [OsuAction.leftButton] },
      { time: -1768, position: { x: 102, y: 202 }, actions: [OsuAction.rightButton] },
      { time: -1752, position: { x: 103, y: 203 }, actions: [OsuAction.leftButton, OsuAction.rightButton] },
    ]);
  });
  it("should treat the key and the mouse buttons of osu!stable the same", function () {
    // K1 = Left1 + Key1 (5), K2 = Right1 + Key2 (10)
    const raw = "0|256|-500|0,-1|256|-500|0,10|1|2|5,10|1|2|10";
    expect(parseReplayFramesFromRaw(raw).map((f) => f.actions)).toEqual([
      [OsuAction.leftButton],
      [OsuAction.rightButton],
    ]);
  });
});
