import { PersistentService } from "../core/service";
import { injectable } from "inversify";
import { JSONSchemaType } from "ajv";
import { BeatmapImportTarget, BeatmapMirrorId } from "../../api";

export interface BeatmapDownloadSettings {
  autoDownload: boolean;
  preferredTarget: BeatmapImportTarget;
  preferredMirror: BeatmapMirrorId;
  noVideo: boolean;
}

export const DEFAULT_BEATMAP_DOWNLOAD_SETTINGS: BeatmapDownloadSettings = Object.freeze({
  autoDownload: true,
  preferredTarget: "auto",
  preferredMirror: "catboy",
  noVideo: true,
});

export const BeatmapDownloadSettingsSchema: JSONSchemaType<BeatmapDownloadSettings> = {
  type: "object",
  properties: {
    autoDownload: { type: "boolean", default: DEFAULT_BEATMAP_DOWNLOAD_SETTINGS.autoDownload },
    preferredTarget: {
      type: "string",
      enum: ["auto", "lazer", "stable"],
      default: DEFAULT_BEATMAP_DOWNLOAD_SETTINGS.preferredTarget,
    },
    preferredMirror: {
      type: "string",
      enum: ["catboy", "nerinyan", "osudirect"],
      default: DEFAULT_BEATMAP_DOWNLOAD_SETTINGS.preferredMirror,
    },
    noVideo: { type: "boolean", default: DEFAULT_BEATMAP_DOWNLOAD_SETTINGS.noVideo },
  },
  required: [],
};

@injectable()
export class BeatmapDownloadSettingsStore extends PersistentService<BeatmapDownloadSettings> {
  key = "beatmap-download";
  schema = BeatmapDownloadSettingsSchema;

  getDefaultValue(): BeatmapDownloadSettings {
    return DEFAULT_BEATMAP_DOWNLOAD_SETTINGS;
  }
}
