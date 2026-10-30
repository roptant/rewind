import { RealmObject, RealmReader } from "./RealmReader";

// osu!lazer stores its data in a `client.realm` file and all the user files (beatmaps, skins, replays) in a `files`
// folder where each file is named after its SHA-256 hash.
// The table names come from the `[MapTo]` attributes in osu.Game (e.g. `BeatmapInfo` is mapped to `Beatmap`).
// https://github.com/ppy/osu/wiki/User-file-storage

export interface LazerNamedFile {
  // The name of the file as it was in the imported .osz/.osk (might contain sub folders e.g. "sb/bg.png")
  filename: string;
  // SHA-256 hash of the file, which is also the name of the file in the `files` folder
  hash: string;
}

export interface LazerBeatmap {
  md5Hash: string;
  // SHA-256 hash of the .osu file
  hash: string;
  osuFileName: string;
  difficultyName: string;
  artist: string;
  artistUnicode: string;
  title: string;
  titleUnicode: string;
  creator: string;
  audioFileName: string;
  backgroundFileName: string;
  rulesetId: number;
  lastPlayed: Date | null;
  // All files of the beatmap set this beatmap belongs to
  files: LazerNamedFile[];
}

export interface LazerSkin {
  id: string;
  name: string;
  creator: string;
  // Built-in skins of osu!lazer are protected and don't have any files
  isProtected: boolean;
  files: LazerNamedFile[];
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");
const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);
const asKeys = (value: unknown): number[] => (Array.isArray(value) ? (value as number[]) : []);

function byKey(objects: RealmObject[]): Map<number, RealmObject> {
  return new Map(objects.map((o) => [o.key, o]));
}

/**
 * Returns the relative path to the file with the given hash inside the osu!lazer data folder.
 * Example: `files/a/ab/abcdef...`
 */
export function lazerFilePath(hash: string): string {
  return `files/${hash.substring(0, 1)}/${hash.substring(0, 2)}/${hash}`;
}

// Same as osu!lazer, the file names are compared case-insensitively and with forward slashes as separators
export function normalizeLazerFileName(fileName: string): string {
  return fileName.replace(/\\/g, "/").toLowerCase();
}

export function findLazerFile(files: LazerNamedFile[], fileName: string): LazerNamedFile | undefined {
  const normalized = normalizeLazerFileName(fileName);
  return files.find((f) => normalizeLazerFileName(f.filename) === normalized);
}

/**
 * Reads the beatmaps and skins from osu!lazer's `client.realm`.
 */
export class LazerDBReader {
  private readonly reader: RealmReader;
  private namedFileUsages?: Map<number, LazerNamedFile>;

  constructor(buffer: Buffer) {
    this.reader = new RealmReader(buffer);
  }

  readBeatmaps(): LazerBeatmap[] {
    const sets = this.reader.readTable("class_BeatmapSet", ["Files", "DeletePending"]);
    const metadataByKey = byKey(
      this.reader.readTable("class_BeatmapMetadata", [
        "Title",
        "TitleUnicode",
        "Artist",
        "ArtistUnicode",
        "Author",
        "AudioFile",
        "BackgroundFile",
      ]),
    );
    const usersByKey = byKey(this.reader.readTable("class_RealmUser", ["Username"]));
    const rulesetsByKey = byKey(this.reader.readTable("class_Ruleset", ["OnlineID"]));

    const setsByKey = new Map<number, { files: LazerNamedFile[]; deletePending: boolean }>();
    for (const set of sets) {
      setsByKey.set(set.key, { files: this.resolveFiles(set.Files), deletePending: set.DeletePending === true });
    }

    const beatmaps: LazerBeatmap[] = [];
    const rows = this.reader.readTable("class_Beatmap", [
      "DifficultyName",
      "Ruleset",
      "Metadata",
      "BeatmapSet",
      "Hash",
      "MD5Hash",
      "LastPlayed",
    ]);
    for (const row of rows) {
      const setKey = asNumber(row.BeatmapSet);
      const set = setKey !== null ? setsByKey.get(setKey) : undefined;
      const md5Hash = asString(row.MD5Hash);
      // Beatmaps that are pending to be deleted are not shown in osu!lazer, and their files might be gone already
      if (!set || set.deletePending || !md5Hash) continue;

      const metadataKey = asNumber(row.Metadata);
      const metadata = metadataKey !== null ? metadataByKey.get(metadataKey) : undefined;
      const authorKey = asNumber(metadata?.Author);
      const author = authorKey !== null ? usersByKey.get(authorKey) : undefined;
      const rulesetKey = asNumber(row.Ruleset);
      const ruleset = rulesetKey !== null ? rulesetsByKey.get(rulesetKey) : undefined;
      const hash = asString(row.Hash);

      beatmaps.push({
        md5Hash,
        hash,
        osuFileName: set.files.find((f) => f.hash === hash)?.filename ?? "",
        difficultyName: asString(row.DifficultyName),
        artist: asString(metadata?.Artist),
        artistUnicode: asString(metadata?.ArtistUnicode),
        title: asString(metadata?.Title),
        titleUnicode: asString(metadata?.TitleUnicode),
        creator: asString(author?.Username),
        audioFileName: asString(metadata?.AudioFile),
        backgroundFileName: asString(metadata?.BackgroundFile),
        rulesetId: asNumber(ruleset?.OnlineID) ?? -1,
        lastPlayed: row.LastPlayed instanceof Date ? row.LastPlayed : null,
        files: set.files,
      });
    }
    return beatmaps;
  }

  readSkins(): LazerSkin[] {
    const skins = this.reader.readTable("class_Skin", ["ID", "Name", "Creator", "Protected", "Files", "DeletePending"]);
    return skins
      .filter((skin) => skin.DeletePending !== true)
      .map((skin) => ({
        id: asString(skin.ID),
        name: asString(skin.Name),
        creator: asString(skin.Creator),
        isProtected: skin.Protected === true,
        files: this.resolveFiles(skin.Files),
      }));
  }

  private resolveFiles(usageKeys: unknown): LazerNamedFile[] {
    const usages = this.getNamedFileUsages();
    const files: LazerNamedFile[] = [];
    for (const key of asKeys(usageKeys)) {
      const usage = usages.get(key);
      if (usage) files.push(usage);
    }
    return files;
  }

  // `RealmNamedFileUsage` are embedded objects that are shared by beatmap sets, skins and scores
  private getNamedFileUsages(): Map<number, LazerNamedFile> {
    if (this.namedFileUsages) return this.namedFileUsages;

    const fileHashes = new Map<number, string>();
    for (const file of this.reader.readTable("class_File", ["Hash"])) {
      fileHashes.set(file.key, asString(file.Hash));
    }
    const usages = new Map<number, LazerNamedFile>();
    for (const usage of this.reader.readTable("class_RealmNamedFileUsage", ["File", "Filename"])) {
      const fileKey = asNumber(usage.File);
      const hash = fileKey !== null ? fileHashes.get(fileKey) : undefined;
      if (hash) usages.set(usage.key, { filename: asString(usage.Filename), hash });
    }
    return (this.namedFileUsages = usages);
  }
}
