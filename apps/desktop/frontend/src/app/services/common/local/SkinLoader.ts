import { Loader, LoaderResource } from "@pixi/loaders";
import { Texture, utils } from "pixi.js";
import { DEFAULT_SKIN_TEXTURE_CONFIG, OsuSkinTextures } from "@rewind/osu/skin";
import { inject, injectable } from "inversify";
import { Skin, SkinTexturesByKey } from "../../../model/Skin";
import { SkinId } from "../../../model/SkinId";
import { OsuFolderService } from "./OsuFolderService";
import { LazerDBDao } from "./LazerDBDao";
import { GetTextureFileOption, OsuLegacySkinTextureResolver, SkinFolderReader } from "@rewind/osu-local/skin-reader";
import { lazerFilePath } from "@rewind/osu-local/db-reader";
import { join } from "path";
import { pathToFileURL } from "url";
import { STAGE_TYPES } from "../../types";

export type SkinTextureFile = { fileName: string; url: string };
export type SkinTextureLocation = { key: OsuSkinTextures; files: SkinTextureFile[] };

// Where the files of a skin can be found
type SkinFileSource = {
  resolver: OsuLegacySkinTextureResolver;
  // The URL to the given file name of the skin
  getUrl: (fileName: string) => string;
};

async function startLoading(loader: Loader, skinName: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    loader.onStart.once(() => {
      console.log(`Skin loading started for ${skinName}`);
    });

    loader.onComplete.once(() => {
      console.debug(`Skin loading completed for ${skinName}`);
      resolve(true);
    });

    loader.onError.once((resource) => {
      console.error(`Could not load resource ${resource.name}`);
    });
    loader.load();
  });
}

const OSU_DEFAULT_SKIN_ID: SkinId = { source: "rewind", name: "OsuDefaultSkin" };

@injectable()
export class SkinLoader {
  skins: { [key: string]: Skin };
  skinElementCounter = 0;

  // Maybe generalize it to skinSource or something
  // TODO: Maybe just load into TextureManager
  constructor(
    private osuFolderService: OsuFolderService,
    private lazerDbDao: LazerDBDao,
    @inject(STAGE_TYPES.REWIND_SKINS_FOLDER) private rewindSkinsFolder: string,
  ) {
    this.skins = {};
  }

  // TODO: AppResourcesPath and get the included Rewind Skins

  async loadSkinList(): Promise<SkinId[]> {
    if (this.osuFolderService.getOsuClient() === "lazer") {
      const skins = await this.lazerDbDao.getAllSkins();
      return (
        skins
          // The built-in skins of osu!lazer don't have any files
          .filter((skin) => skin.files.length > 0)
          .map((skin): SkinId => ({ source: "lazer", name: skin.name }))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
    }
    const skinNames = await SkinFolderReader.listSkinsInFolder(join(this.osuFolderService.getOsuFolder(), "Skins"), {
      skinIniRequired: false,
    });
    return skinNames.map((name): SkinId => ({ source: "osu", name }));
  }

  sourcePath(source: string) {
    switch (source) {
      case "rewind":
        return this.rewindSkinsFolder;
      case "osu":
        return join(this.osuFolderService.getOsuFolder(), "Skins");
    }
    return "";
  }

  resolveToPath({ source, name }: SkinId) {
    return join(this.sourcePath(source), name);
  }

  async getSkinFileSource(skinId: SkinId): Promise<SkinFileSource> {
    if (skinId.source === "lazer") {
      // osu!lazer stores the files of the skins by their hashes
      const skin = (await this.lazerDbDao.getAllSkins()).find((s) => s.name === skinId.name);
      if (!skin) {
        throw new Error(`Could not find the osu!lazer skin '${skinId.name}'`);
      }
      const lazerFolder = this.osuFolderService.getOsuFolder();
      const resolver = await SkinFolderReader.getMappedSkinResolver(
        skin.files.map((f) => ({ fileName: f.filename, path: join(lazerFolder, lazerFilePath(f.hash)) })),
      );
      // The same file could be used by multiple textures. Since Pixi caches the textures by their URLs, the file name
      // is added as a fragment to keep them unique.
      const getUrl = (fileName: string) =>
        `${pathToFileURL(resolver.getFilePath(fileName) ?? "").href}#${encodeURIComponent(fileName)}`;
      return { resolver, getUrl };
    }
    const skinFolder = this.resolveToPath(skinId);
    const resolver = await SkinFolderReader.getSkinResolver(skinFolder);
    return { resolver, getUrl: (fileName) => `${join("file://", skinFolder)}/${fileName}` };
  }

  /**
   * In the future we also want to get the skin info with the beatmap as the parameters in order to retrieve
   * beatmap related skin files as well.
   */
  async resolve(
    osuSkinTexture: OsuSkinTextures,
    options: GetTextureFileOption,
    list: SkinFileSource[],
  ): Promise<SkinTextureFile[]> {
    for (const { resolver, getUrl } of list) {
      const fileNames = await resolver.resolve(osuSkinTexture, options);
      if (fileNames.length === 0) {
        continue;
      }
      return fileNames.map((fileName) => ({ fileName, url: getUrl(fileName) }));
    }
    console.debug(`No skin has the skin texture ${osuSkinTexture}`);
    return [];
  }

  // force such like reloading
  async loadSkin(skinId: SkinId, forceReload?: boolean): Promise<Skin> {
    const id = `${skinId.source}/${skinId.name}`;
    if (this.skins[id] && !forceReload) {
      console.info(`Skin ${id} is already loaded, using the one in cache`);
      return this.skins[id];
    }
    console.log(`Loading skin with name: ${skinId.name} with source ${skinId.source}`);
    const loader = new Loader();

    const osuDefaultSkinSource = await this.getSkinFileSource(OSU_DEFAULT_SKIN_ID);
    const skinSource = await this.getSkinFileSource(skinId);

    const { config } = skinSource.resolver;

    const skinTextureKeys = Object.keys(DEFAULT_SKIN_TEXTURE_CONFIG);
    const files: SkinTextureLocation[] = await Promise.all(
      skinTextureKeys.map(async (key) => ({
        key: key as OsuSkinTextures,
        // In the future beatmap stuff can be listed here as well
        files: await this.resolve(key as OsuSkinTextures, { animatedIfExists: true, hdIfExists: true }, [
          skinSource,
          osuDefaultSkinSource,
        ]),
      })),
    );

    const textures: SkinTexturesByKey = {};
    const skinName = config.general.name;

    // Every file, even non-animatable files have the index in their name
    // For example "WhiteCat/hitcircle-0" would be one key name

    const queueFiles: { key: OsuSkinTextures; name: string }[] = [];
    files.forEach((stl) => {
      stl.files.forEach(({ fileName, url }, index) => {
        // `Loader` will die if the same `name` gets used twice therefore the unique skinElementCounter
        // Maybe even use a timestamp
        const name = `${this.skinElementCounter++}/${skinName}/${stl.key}-${index}`;
        // The type and the resolution (e.g. "@2x") are determined by the file name and not the URL, since the URL
        // doesn't contain the file name for osu!lazer skins
        loader.add(name, url, {
          loadType: LoaderResource.LOAD_TYPE.IMAGE,
          metadata: { resolution: utils.getResolutionOfUrl(fileName) },
        });
        queueFiles.push({ key: stl.key, name });
      });
    });

    const loaded = await startLoading(loader, skinName);

    if (!loaded) {
      throw new Error(`${skinName} not loaded correctly`);
    }

    queueFiles.forEach((file) => {
      if (!(file.key in textures)) textures[file.key] = [];
      textures[file.key]?.push(loader.resources[file.name].texture as Texture);
    });

    return (this.skins[id] = new Skin(config, textures));
  }
}
