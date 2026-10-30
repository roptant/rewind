import { LazerNamedFile } from "@rewind/osu-local/db-reader";

export interface BlueprintInfo {
  md5Hash: string;
  lastPlayed: Date;
  title: string;
  artist: string;
  creator: string;
  // This is assuming that they are in the folderName
  folderName: string;
  audioFileName: string;
  osuFileName: string;

  // [Events]
  bgFileName?: string; // Usually unknown unless .osu file is parsed

  // osu!lazer doesn't store the beatmaps in folders, instead all files of the beatmap set are stored by their hashes
  lazerFiles?: LazerNamedFile[];
}
