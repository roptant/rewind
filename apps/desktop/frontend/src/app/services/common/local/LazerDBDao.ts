import { join } from "path";
import { open, readFile } from "fs/promises";
import { LazerBeatmap, LazerDBReader, LazerSkin } from "@rewind/osu-local/db-reader";
import { injectable } from "inversify";
import { BlueprintInfo } from "../../../model/BlueprintInfo";
import { OsuFolderService } from "./OsuFolderService";

// The first bytes of a Realm file contain the reference to the latest commit, so they change with every write. This is
// more reliable than the last modified time, since osu!lazer keeps the file open (and memory mapped) while running.
const REALM_HEADER_SIZE = 24;

const mapToBlueprint = (b: LazerBeatmap): BlueprintInfo => {
  return {
    md5Hash: b.md5Hash,
    audioFileName: b.audioFileName,
    folderName: "",
    lastPlayed: b.lastPlayed ?? new Date(0),
    osuFileName: b.osuFileName,
    artist: b.artist,
    title: b.title,
    creator: b.creator,
    bgFileName: b.backgroundFileName,
    lazerFiles: b.files,
  };
};

/**
 * Reads the beatmaps and skins from the osu!lazer database (`client.realm`).
 */
@injectable()
export class LazerDBDao {
  private lastVersion = "";
  private blueprints: Record<string, BlueprintInfo> = {};
  private skins: LazerSkin[] = [];
  private reading?: Promise<void>;

  constructor(private readonly osuFolderService: OsuFolderService) {
    // We just assume that we need to read it again
    this.osuFolderService.settings$.subscribe(() => {
      this.lastVersion = "";
      this.blueprints = {};
      this.skins = [];
    });
  }

  private get realmPath() {
    return join(this.osuFolderService.getOsuFolder(), "client.realm");
  }

  async getRealmVersion(): Promise<string> {
    const file = await open(this.realmPath, "r");
    try {
      const { buffer } = await file.read(Buffer.alloc(REALM_HEADER_SIZE), 0, REALM_HEADER_SIZE, 0);
      return buffer.toString("hex");
    } finally {
      await file.close();
    }
  }

  async hasChanged(): Promise<boolean> {
    return this.lastVersion !== (await this.getRealmVersion());
  }

  private async read() {
    if (!(await this.hasChanged())) {
      return;
    }
    // The whole file is read at once so that we get a consistent snapshot even if osu!lazer is writing to it
    const buffer = await readFile(this.realmPath);
    const version = buffer.toString("hex", 0, REALM_HEADER_SIZE);
    console.log(`Reading the osu!lazer database client.realm with version=${version}`);

    const reader = new LazerDBReader(buffer);
    this.blueprints = {};
    for (const beatmap of reader.readBeatmaps()) {
      this.blueprints[beatmap.md5Hash] = mapToBlueprint(beatmap);
    }
    this.skins = reader.readSkins();
    this.lastVersion = version;
  }

  private async ensureRead() {
    // Prevents reading the (potentially big) file multiple times if requested at the same time
    if (!this.reading) {
      this.reading = (async () => {
        try {
          await this.read();
        } finally {
          this.reading = undefined;
        }
      })();
    }
    return this.reading;
  }

  // The blueprints by their MD5 hash
  async getAllBlueprints(): Promise<Record<string, BlueprintInfo>> {
    await this.ensureRead();
    return this.blueprints;
  }

  async getAllSkins(): Promise<LazerSkin[]> {
    await this.ensureRead();
    return this.skins;
  }
}
