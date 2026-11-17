import { promises as fsPromises } from "fs";
import { Blueprint, BlueprintSection, parseBlueprint } from "@osujs/core";
import { join } from "path";
import { createHash } from "crypto";
import { filterFilenamesInDirectory } from "@rewind/osu-local/utils";
import { injectable } from "inversify";
import { OSU_CLIENTS, OsuClient, OsuFolderService } from "./OsuFolderService";
import { BlueprintInfo } from "../../../model/BlueprintInfo";
import { OsuDBDao } from "./OsuDBDao";
import { LazerDBDao } from "./LazerDBDao";
import { findLazerFile, lazerFilePath } from "@rewind/osu-local/db-reader";

const { stat, readFile } = fsPromises;

const METADATA_SECTIONS_TO_READ: BlueprintSection[] = ["General", "Difficulty", "Events", "Metadata"];

function mapToLocalBlueprint(
  blueprint: Blueprint,
  osuFileName: string,
  folderName: string,
  md5Hash: string,
): BlueprintInfo {
  const { metadata } = blueprint.blueprintInfo;
  return {
    client: "stable",
    creator: "", // TODO: ?
    title: metadata.title,
    osuFileName,
    folderName,
    bgFileName: metadata.backgroundFile,
    md5Hash,
    audioFileName: metadata.audioFile,
    artist: metadata.artist,
    lastPlayed: new Date(),
  };
}

// Basically just the identifier of the blueprint
type BlueprintMD5 = string;

/**
 * Service responsible for locating the blueprints in all osu! installations that are used (osu!stable and osu!lazer).
 *
 * For osu!stable it mainly uses the `osu!.db` to get the majority of the blueprints. However, once the user imports new
 * beatmaps, the `osu!.db` doesn't get immediately updated (no flushing), thus we have to find out which ones were added
 * by manually looking for new files.
 *
 * For osu!lazer all the blueprints are read from its database (`client.realm`), which is updated right away.
 */
@injectable()
export class BlueprintLocatorService {
  private stableBlueprints: Record<BlueprintMD5, BlueprintInfo> = {};
  // Whether the osu!stable blueprints have to be read again completely (e.g. the Songs folder has changed)
  private stableNeedsFullRead = true;

  constructor(
    private readonly osuDbDao: OsuDBDao,
    private readonly lazerDbDao: LazerDBDao,
    private readonly osuFolderService: OsuFolderService,
  ) {
    // Also emits once the Songs folder has been determined (which happens asynchronously after the settings change)
    this.osuFolderService.songsFolder$.subscribe(() => {
      this.stableBlueprints = {};
      this.stableNeedsFullRead = true;
    });
  }

  private get songsFolder() {
    return this.osuFolderService.songsFolder$.getValue();
  }

  private async completeRead() {
    const freshBlueprints = await this.osuDbDao.getAllBlueprints();
    const lastModifiedTime = await this.osuDbDao.getOsuDbLastModifiedTime();

    // The Songs folder might not be determined yet, the beatmaps of the osu!.db can be used anyway
    const songsFolder = this.songsFolder;
    console.log(`Reading the osu!/Songs folder: ${songsFolder}`);
    const candidates = songsFolder ? await getNewFolderCandidates(songsFolder, new Date(lastModifiedTime)) : [];
    if (candidates.length > 0) {
      console.log(`New blueprint candidates (${candidates.length}) : ${candidates.join(",")}`);
    }

    for (const songFolder of candidates) {
      const osuFiles = await listOsuFiles(join(songsFolder, songFolder));
      for (const osuFile of osuFiles) {
        const fileName = join(songsFolder, songFolder, osuFile);
        console.log(`Reading file ${fileName}`);
        const data = await readFile(fileName);
        const hash = createHash("md5");
        hash.update(data);
        const md5Hash = hash.digest("hex");
        const blueprint = await parseBlueprint(data.toString("utf-8"), { sectionsToRead: METADATA_SECTIONS_TO_READ });
        freshBlueprints.push(mapToLocalBlueprint(blueprint, osuFile, songFolder, md5Hash));
      }
    }

    const blueprints: Record<BlueprintMD5, BlueprintInfo> = {};
    freshBlueprints.forEach((blueprint) => (blueprints[blueprint.md5Hash] = blueprint));
    // Read again if the Songs folder was not known yet or has changed in the meantime
    this.stableNeedsFullRead = !songsFolder || songsFolder !== this.songsFolder;
    return (this.stableBlueprints = blueprints);
  }

  async blueprintHasBeenAdded() {
    if (this.stableNeedsFullRead) {
      return true;
    }
    // It's better to rely on the "osu!.db" than the ones we received from watching.
    // But ofc, we if we read from osu!.db again there might still be some folders that have not been properly flushed.
    if (await this.osuDbDao.hasChanged()) {
      return true;
    }
    if (!this.songsFolder) {
      return false;
    }
    const s = await stat(this.songsFolder);
    const t = await this.osuDbDao.getOsuDbLastModifiedTime();
    return s.mtime.getTime() > t;
  }

  /**
   * @returns the blueprints of the given osu! client by their MD5 hash (empty if the client is not used or its data
   * could not be read, so that the other client can still be used)
   */
  async getBlueprintsOfClient(client: OsuClient): Promise<Record<BlueprintMD5, BlueprintInfo>> {
    if (!this.osuFolderService.hasClient(client)) {
      return {};
    }
    try {
      if (client === "lazer") {
        // Cached in the DAO and only read again if osu!lazer has written to its database
        return await this.lazerDbDao.getAllBlueprints();
      }
      if (await this.blueprintHasBeenAdded()) {
        await this.completeRead();
      }
      return this.stableBlueprints;
    } catch (err) {
      console.error(`Could not read the beatmaps of osu!${client}`, err);
      return {};
    }
  }

  /**
   * @returns the blueprints of all osu! installations, if a beatmap is imported in both, the osu!stable one is used
   */
  async getAllBlueprints(): Promise<Record<BlueprintMD5, BlueprintInfo>> {
    const [stable, lazer] = await Promise.all(OSU_CLIENTS.map((client) => this.getBlueprintsOfClient(client)));
    return { ...lazer, ...stable };
  }

  /**
   * Finds the blueprint in any of the osu! installations.
   * @param md5 the MD5 hash of the .osu file
   * @param preferredClient the client that is looked at first (e.g. the one the replay was played on)
   */
  async getBlueprintByMD5(md5: string, preferredClient: OsuClient = "stable"): Promise<BlueprintInfo | undefined> {
    const clients = [preferredClient, ...OSU_CLIENTS.filter((c) => c !== preferredClient)];
    for (const client of clients) {
      const blueprint = (await this.getBlueprintsOfClient(client))[md5];
      if (blueprint) return blueprint;
    }
    return undefined;
  }

  /**
   * Returns the absolute path to a file of the beatmap set that the blueprint belongs to.
   * @param blueprint the blueprint
   * @param fileName the file name as it is referenced in the .osu file (e.g. "audio.mp3")
   * @returns `undefined` if the file is not part of the beatmap set (only known for osu!lazer)
   */
  resolveFilePath(blueprint: BlueprintInfo, fileName: string): string | undefined {
    if (blueprint.client === "lazer") {
      const lazerFolder = this.osuFolderService.getLazerFolder();
      const file = blueprint.lazerFiles && findLazerFile(blueprint.lazerFiles, fileName);
      return lazerFolder && file ? join(lazerFolder, lazerFilePath(file.hash)) : undefined;
    }
    return join(this.songsFolder, blueprint.folderName, fileName);
  }

  public async blueprintBg(md5: string): Promise<string | undefined> {
    const blueprintMetaData = await this.getBlueprintByMD5(md5);
    if (!blueprintMetaData) return undefined;
    const osuFilePath = this.resolveFilePath(blueprintMetaData, blueprintMetaData.osuFileName);
    if (!osuFilePath) return undefined;
    const data = await readFile(osuFilePath, { encoding: "utf-8" });
    const parsedBlueprint = parseBlueprint(data, { sectionsToRead: ["Events"] });
    // There is also an offset but let's ignore for now
    return parsedBlueprint.blueprintInfo.metadata.backgroundFile;
  }
}

// This might be a very expensive operation and should be done only once at startup. The new ones should be watched
// ~250ms at my Songs folder
export async function getNewFolderCandidates(songsFolder: string, importedLaterThan: Date): Promise<string[]> {
  return filterFilenamesInDirectory(songsFolder, async (fileName) => {
    const s = await stat(join(songsFolder, fileName));
    return s.mtime.getTime() > importedLaterThan.getTime() && s.isDirectory();
  });
}

export async function listOsuFiles(songFolder: string): Promise<string[]> {
  return filterFilenamesInDirectory(songFolder, async (fileName) => fileName.endsWith(".osu"));
}
