import { Replay } from "node-osr";
import { isLazerReplayVersion, readLazerScoreInfo } from "./LazerScoreInfo";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const lzma = require("lzma");

const scoreInfo = {
  mods: [{ acronym: "DT", settings: { speed_change: 1.19 } }, { acronym: "MR" }],
  statistics: { great: 669, ok: 42, miss: 36, slider_tail_hit: 401 },
  maximum_statistics: { great: 747, slider_tail_hit: 404 },
  client_version: "2026.921.0-lazer",
};

// Creates an .osr file like osu!lazer exports it: the score information is appended after the online score id
function lazerReplayFile(gameVersion: number, withScoreInfo: boolean): Buffer {
  const replay = new Replay();
  replay.gameVersion = gameVersion;
  replay.beatmapMD5 = "884cd32223dbfd9c302cdfdf64a228b1";
  replay.playerName = "roptant";
  replay.replayMD5 = "a2f602eb43482a8d";
  replay.mods = 64;
  replay.replay_data = "0|256|-500|0,-1|256|-500|0,16|100.5|200.25|1,-12345|0|0|0";
  const osr = replay.serializeSync() as Buffer;
  if (!withScoreInfo) return osr;
  const compressed = Buffer.from(lzma.compress(JSON.stringify(scoreInfo), 1));
  const length = Buffer.alloc(4);
  length.writeInt32LE(compressed.length);
  return Buffer.concat([osr, length, compressed]);
}

describe("readLazerScoreInfo", () => {
  it("reads the osu!lazer mods and statistics", () => {
    expect(readLazerScoreInfo(lazerReplayFile(30000019, true))).toEqual(scoreInfo);
  });

  it("returns null if the replay does not contain any", () => {
    expect(readLazerScoreInfo(lazerReplayFile(30000000, false))).toBeNull();
    expect(readLazerScoreInfo(lazerReplayFile(20211103, false))).toBeNull();
  });

  it("detects osu!lazer replays by their version", () => {
    expect(isLazerReplayVersion(30000019)).toBe(true);
    expect(isLazerReplayVersion(20211103)).toBe(false);
  });
});
