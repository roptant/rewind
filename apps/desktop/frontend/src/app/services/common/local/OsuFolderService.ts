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

export const OSU_CLIENTS: OsuClient[] = ["stable", "lazer"];

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
  if (!osuFolderPath) return false;
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

/**
 * The default locations of the osu! installations, used to pre-fill the setup screen.
 */
export function defaultOsuFolderCandidates(client: OsuClient): string[] {
  const { platform, env } = process;
  const home = env["HOME"] ?? env["USERPROFILE"] ?? "";
  if (client === "stable") {
    return platform === "win32" && env["LOCALAPPDATA"] ? [join(env["LOCALAPPDATA"], "osu!")] : [];
  }
  switch (platform) {
    case "win32":
      return env["APPDATA"] ? [join(env["APPDATA"], "osu")] : [];
    case "darwin":
      return [join(home, "Library", "Application Support", "osu")];
    default:
      return [join(env["XDG_DATA_HOME"] ?? join(home, ".local", "share"), "osu")];
  }
}

/**
 * Returns the first default location of the given client that contains a valid osu! installation.
 */
export async function guessOsuFolder(client: OsuClient): Promise<string | null> {
  for (const candidate of defaultOsuFolderCandidates(client)) {
    const folder = await detectOsuFolder(candidate);
    if (folder?.client === client) return folder.path;
  }
  return null;
}

interface OsuSettings {
  // An empty string means that the installation is not used
  osuStablePath: string;
  osuLazerPath: string;
}

export const DEFAULT_OSU_SETTINGS: OsuSettings = Object.freeze({
  osuStablePath: "",
  osuLazerPath: "",
});
export const OsuSettingsSchema: JSONSchemaType<OsuSettings> = {
  type: "object",
  properties: {
    osuStablePath: { type: "string", default: DEFAULT_OSU_SETTINGS.osuStablePath },
    osuLazerPath: { type: "string", default: DEFAULT_OSU_SETTINGS.osuLazerPath },
  },
  required: [],
};

/**
 * Manages the osu! installations that Rewind uses. Both osu!stable and osu!lazer can be used at the same time, so that
 * replays can be loaded regardless of which client the beatmap was imported in.
 */
@injectable()
export class OsuFolderService extends PersistentService<OsuSettings> {
  // The folders that are watched for new replays ("Replays" for osu!stable and "exports" for osu!lazer)
  public replaysFolders$ = new BehaviorSubject<string[]>([]);
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
    const stableFolder = osuSettings.osuStablePath;
    const lazerFolder = osuSettings.osuLazerPath;
    // osu!lazer doesn't have a "Replays" folder, the replays are only written as files when they get exported
    const replaysFolders = [stableFolder && join(stableFolder, "Replays"), lazerFolder && join(lazerFolder, "exports")];
    this.replaysFolders$.next(replaysFolders.filter((f) => !!f));
    ipcRenderer.send("osuFolderChanged", { stableFolder, lazerFolder });
    if (!stableFolder) {
      this.songsFolder$.next("");
    } else {
      const userId = await username();
      const songsFolder = (await determineSongsFolder(stableFolder, userId as string)) as string;
      // The settings could have been changed in the meantime
      if (this.settings === osuSettings) {
        this.songsFolder$.next(songsFolder);
      }
    }
  }

  /**
   * @returns the folder of the given osu! client or `undefined` if that client is not used
   */
  getFolder(client: OsuClient): string | undefined {
    return (client === "lazer" ? this.settings.osuLazerPath : this.settings.osuStablePath) || undefined;
  }

  getStableFolder() {
    return this.getFolder("stable");
  }

  getLazerFolder() {
    return this.getFolder("lazer");
  }

  // The osu! clients that are used
  getClients(): OsuClient[] {
    return OSU_CLIENTS.filter((client) => this.getFolder(client) !== undefined);
  }

  hasClient(client: OsuClient): boolean {
    return this.getFolder(client) !== undefined;
  }

  /**
   * Sets the folders of both osu! clients at once.
   * @param folders the folder of each client, `null` if the client should not be used anymore
   */
  setOsuFolders(folders: Record<OsuClient, string | null>) {
    console.log(`osu! folders were set to stable='${folders.stable ?? ""}' lazer='${folders.lazer ?? ""}'`);
    this.changeSettings((draft) => {
      draft.osuStablePath = folders.stable ?? "";
      draft.osuLazerPath = folders.lazer ?? "";
    });
  }

  async detectOsuFolder(directoryPath: string) {
    return detectOsuFolder(directoryPath);
  }

  // The clients whose folders are set and valid
  async validClients(): Promise<OsuClient[]> {
    const valid = await Promise.all(
      OSU_CLIENTS.map(async (client) => osuFolderSanityCheck(this.getFolder(client) ?? "", client)),
    );
    return OSU_CLIENTS.filter((_, i) => valid[i]);
  }

  async hasValidOsuFolderSet(): Promise<boolean> {
    return (await this.validClients()).length > 0;
  }
}
