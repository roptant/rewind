import { promises as fsPromises } from "fs";
import { Blueprint, BlueprintSection, parseBlueprint } from "@osujs/core";
import { join } from "path";
import { createHash } from "crypto";
import { filterFilenamesInDirectory } from "@rewind/osu-local/utils";
import { injectable } from "inversify";
import { OsuFolderService } from "./OsuFolderService";
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
 * Service responsible for locating the blueprints.
 *
 * For osu!stable it mainly uses the `osu!.db` to get the majority of the blueprints. However, once the user imports new
 * beatmaps, the `osu!.db` doesn't get immediately updated (no flushing), thus we have to find out which ones were added
 * by manually looking for new files.
 *
 * For osu!lazer all the blueprints are read from its database (`client.realm`), which is updated right away.
 */
@injectable()
export class BlueprintLocatorService {
  private blueprints: Record<BlueprintMD5, BlueprintInfo> = {};

  constructor(
    private readonly osuDbDao: OsuDBDao,
    private readonly lazerDbDao: LazerDBDao,
    private readonly osuFolderService: OsuFolderService,
  ) {}

  private get songsFolder() {
    return this.osuFolderService.songsFolder$.getValue();
  }

  private async completeRead() {
    const freshBlueprints = await this.osuDbDao.getAllBlueprints();
    const lastModifiedTime = await this.osuDbDao.getOsuDbLastModifiedTime();

    console.log(`Reading the osu!/Songs folder: ${this.songsFolder}`);
    const candidates = await getNewFolderCandidates(this.songsFolder, new Date(lastModifiedTime));
    if (candidates.length > 0) {
      console.log(`New blueprint candidates (${candidates.length}) : ${candidates.join(",")}`);
    }

    for (const songFolder of candidates) {
      const osuFiles = await listOsuFiles(join(this.songsFolder, songFolder));
      for (const osuFile of osuFiles) {
        const fileName = join(this.songsFolder, songFolder, osuFile);
        console.log(`Reading file ${fileName}`);
        const data = await readFile(fileName);
        const hash = createHash("md5");
        hash.update(data);
        const md5Hash = hash.digest("hex");
        const blueprint = await parseBlueprint(data.toString("utf-8"), { sectionsToRead: METADATA_SECTIONS_TO_READ });
        freshBlueprints.push(mapToLocalBlueprint(blueprint, osuFile, songFolder, md5Hash));
      }
    }

    this.blueprints = {};
    freshBlueprints.forEach(this.addNewBlueprint.bind(this));
    return this.blueprints;
  }

  // Usually for watchers
  private addNewBlueprint(blueprint: BlueprintInfo) {
    this.blueprints[blueprint.md5Hash] = blueprint;
  }

  async blueprintHasBeenAdded() {
    // It's better to rely on the "osu!.db" than the ones we received from watching.
    // But ofc, we if we read from osu!.db again there might still be some folders that have not been properly flushed.
    if (await this.osuDbDao.hasChanged()) {
      return true;
    }
    const s = await stat(this.songsFolder);
    const t = await this.osuDbDao.getOsuDbLastModifiedTime();
    return s.mtime.getTime() > t;
  }

  async getAllBlueprints(): Promise<Record<string, BlueprintInfo>> {
    if (this.osuFolderService.getOsuClient() === "lazer") {
      // Cached in the DAO and only read again if osu!lazer has written to its database
      return this.lazerDbDao.getAllBlueprints();
    }
    const needToCheckAgain = await this.blueprintHasBeenAdded();
    if (needToCheckAgain) {
      await this.completeRead();
    }
    return this.blueprints;
  }

  async getBlueprintByMD5(md5: string): Promise<BlueprintInfo | undefined> {
    const maps = await this.getAllBlueprints();
    return maps[md5];
  }

  /**
   * Returns the absolute path to a file of the beatmap set that the blueprint belongs to.
   * @param blueprint the blueprint
   * @param fileName the file name as it is referenced in the .osu file (e.g. "audio.mp3")
   * @returns `undefined` if the file is not part of the beatmap set (only known for osu!lazer)
   */
  resolveFilePath(blueprint: BlueprintInfo, fileName: string): string | undefined {
    if (blueprint.lazerFiles) {
      const file = findLazerFile(blueprint.lazerFiles, fileName);
      return file && join(this.osuFolderService.getOsuFolder(), lazerFilePath(file.hash));
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
