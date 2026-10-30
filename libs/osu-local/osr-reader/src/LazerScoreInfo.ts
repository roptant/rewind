/// <reference path="./lzma.d.ts" />
import { decompress } from "lzma";

// Replays exported by osu!lazer have a version of 30000000 or above (osu!stable uses dates such as 20211103)
const FIRST_LAZER_VERSION = 30000000;

const TARGET_PRACTICE_MOD = 1 << 23;

export interface LazerScoreInfoMod {
  acronym: string;
  settings?: Record<string, unknown>;
}

/**
 * The additional score information that osu!lazer appends to the .osr files it exports. Most importantly it contains
 * the osu!lazer mods with their settings, which can not be represented by the legacy mods bitmask (e.g. Mirror or DT
 * with a custom speed). See `LegacyReplaySoloScoreInfo` in osu!lazer.
 */
export interface LazerScoreInfo {
  mods: LazerScoreInfoMod[];
  // For example { great: 300, ok: 2, large_tick_hit: 20, slider_tail_hit: 40 }
  statistics: Record<string, number>;
  maximum_statistics: Record<string, number>;
  client_version?: string;
  rank?: string;
}

export function isLazerReplayVersion(gameVersion: number): boolean {
  return gameVersion >= FIRST_LAZER_VERSION;
}

/**
 * Reads the osu!lazer score information at the end of the given .osr file.
 * @returns `null` if the replay does not contain it (osu!stable replays and older osu!lazer replays)
 */
export function readLazerScoreInfo(buffer: Buffer): LazerScoreInfo | null {
  let position = 0;
  const skipString = () => {
    // 0x0b indicates that a ULEB128 length and the string follow
    if (buffer[position++] !== 0x0b) return;
    let length = 0;
    let shift = 0;
    let byte;
    do {
      byte = buffer[position++];
      length |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80);
    position += length;
  };

  try {
    const gameVersion = buffer.readInt32LE(1);
    if (!isLazerReplayVersion(gameVersion)) return null;
    position = 5;
    skipString(); // beatmap MD5
    skipString(); // player name
    skipString(); // replay MD5
    position += 6 * 2 + 4 + 2 + 1; // judgement counts, score, max combo, perfect
    const mods = buffer.readInt32LE(position);
    position += 4;
    skipString(); // life bar graph
    position += 8; // timestamp
    position += 4 + buffer.readInt32LE(position); // replay data
    position += 8; // online score id
    if (mods & TARGET_PRACTICE_MOD) position += 8; // accuracy

    if (position + 4 > buffer.length) return null;
    const length = buffer.readInt32LE(position);
    position += 4;
    const data = decompress(Array.from(buffer.subarray(position, position + length)));
    const json = typeof data === "string" ? data : Buffer.from(data).toString("utf-8");
    return JSON.parse(json) as LazerScoreInfo;
  } catch (err) {
    console.warn("Could not read the osu!lazer score information of the replay", err);
    return null;
  }
}
