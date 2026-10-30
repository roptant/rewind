import { readFile } from "fs/promises";
import { join } from "path";
import { osuUserConfigParse } from "./osuUserConfig";

/**
 * Returns the absolute path to the osu!lazer data folder.
 *
 * osu!lazer allows the user to move the data to a different location, in which case the default data folder (e.g.
 * `%APPDATA%/osu` on Windows) only contains a `storage.ini` that points to the actual location.
 * @param folderPath the default data folder or the actual data folder
 */
export async function determineLazerDataFolder(folderPath: string): Promise<string> {
  try {
    const data = await readFile(join(folderPath, "storage.ini"), "utf-8");
    const fullPath = osuUserConfigParse(data)["FullPath"];
    if (fullPath) {
      return fullPath.trim();
    }
  } catch (err) {
    // No custom storage location
  }
  return folderPath;
}
