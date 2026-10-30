// TODO: Rename this to replay or something
import { LazerMod, OsuClassicMod, ReplayFrame } from "@osujs/core";

export type OsuReplay = {
  md5hash: string;
  beatmapMd5: string;
  gameVersion: number;
  mods: OsuClassicMod[];
  player: string; // Could be useful to draw
  frames: ReplayFrame[];
  // Only for replays from osu!lazer: the mods with their settings (`mods` only contains the legacy mods)
  lazerMods?: LazerMod[];
};
