import { injectable } from "inversify";
import { access } from "fs/promises";
import { join } from "path";
import { constants } from "fs";
import { BehaviorSubject } from "rxjs";
import { determineLazerDataFolder, determineSongsFolder } from "@rewind/osu-local/utils";
import username from "username";
import { ipcRenderer } from "electron";
import { PersistentService } from "../../core/service";
import { JSONSchemaType } from "ajv";

export type OsuClient = "stable" | "lazer";

const filesToCheck: Record<OsuClient, string[]> = {
  stable: ["osu!.db", "scores.db", "Skins"],
  lazer: ["client.realm", "files"],
};

async function canAccessFiles(folderPath: string, files: string[]) {
  try {
    await Promise.all(files.map((f) => access(join(folderPath, f), constants.R_OK)));
  } catch (err) {
    return false;
  }
  return true;
}

/**
 * Checks certain files to see if Rewind can be booted without any problems with the given `osuFolderPath`.
 * @param osuFolderPath the folder path to check the files in
 * @param client the osu! client that the folder should belong to
 */
export async function osuFolderSanityCheck(osuFolderPath: string, client: OsuClient) {
  return canAccessFiles(osuFolderPath, filesToCheck[client]);
}

export interface OsuFolder {
  path: string;
  client: OsuClient;
}

/**
 * Determines whether the given directory is an osu!stable or an osu!lazer folder.
 * @param directoryPath the osu!stable folder or the osu!lazer data folder (could also be the default one that points
 * to a custom storage location)
 * @returns the actual osu! folder or `null` if it is not a valid one
 */
export async function detectOsuFolder(directoryPath: string): Promise<OsuFolder | null> {
  if (await osuFolderSanityCheck(directoryPath, "stable")) {
    return { path: directoryPath, client: "stable" };
  }
  const lazerDataFolder = await determineLazerDataFolder(directoryPath);
  if (await osuFolderSanityCheck(lazerDataFolder, "lazer")) {
    return { path: lazerDataFolder, client: "lazer" };
  }
  return null;
}

interface OsuSettings {
  client: OsuClient;
  osuStablePath: string;
  osuLazerPath: string;
}

export const DEFAULT_OSU_SETTINGS: OsuSettings = Object.freeze({
  client: "stable",
  osuStablePath: "",
  osuLazerPath: "",
});
export const OsuSettingsSchema: JSONSchemaType<OsuSettings> = {
  type: "object",
  properties: {
    client: { type: "string", enum: ["stable", "lazer"], default: DEFAULT_OSU_SETTINGS.client },
    osuStablePath: { type: "string", default: DEFAULT_OSU_SETTINGS.osuStablePath },
    osuLazerPath: { type: "string", default: DEFAULT_OSU_SETTINGS.osuLazerPath },
  },
  required: [],
};

@injectable()
export class OsuFolderService extends PersistentService<OsuSettings> {
  public replaysFolder$ = new BehaviorSubject<string>("");
  // Only for osu!stable since osu!lazer doesn't store the beatmaps in folders
  public songsFolder$ = new BehaviorSubject<string>("");

  key = "osu-settings";
  schema = OsuSettingsSchema;

  constructor() {
    super();
    this.settings$.subscribe(this.onFolderChange.bind(this));
  }

  getDefaultValue(): OsuSettings {
    return DEFAULT_OSU_SETTINGS;
  }

  async onFolderChange(osuSettings: OsuSettings) {
    const osuFolder = osuSettings.client === "lazer" ? osuSettings.osuLazerPath : osuSettings.osuStablePath;
    // osu!lazer doesn't have a "Replays" folder, the replays are only written as files when they get exported
    const replaysFolder = join(osuFolder, osuSettings.client === "lazer" ? "exports" : "Replays");
    ipcRenderer.send("osuFolderChanged", osuFolder, replaysFolder);
    this.replaysFolder$.next(replaysFolder);
    if (osuSettings.client === "lazer") {
      this.songsFolder$.next("");
    } else {
      const userId = await username();
      const songsFolder = (await determineSongsFolder(osuFolder, userId as string)) as string;
      // The settings could have been changed in the meantime
      if (this.settings === osuSettings) {
        this.songsFolder$.next(songsFolder);
      }
    }
  }

  getOsuClient(): OsuClient {
    return this.settings.client;
  }

  getOsuFolder(): string {
    return this.settings.client === "lazer" ? this.settings.osuLazerPath : this.settings.osuStablePath;
  }

  setOsuFolder({ path, client }: OsuFolder) {
    console.log(`osu! folder was set to '${path}' (${client})`);
    this.changeSettings((draft) => {
      draft.client = client;
      if (client === "lazer") {
        draft.osuLazerPath = path;
      } else {
        draft.osuStablePath = path;
      }
    });
  }

  async detectOsuFolder(directoryPath: string) {
    return detectOsuFolder(directoryPath);
  }

  async hasValidOsuFolderSet(): Promise<boolean> {
    return osuFolderSanityCheck(this.getOsuFolder(), this.getOsuClient());
  }
}
