export type SkinSource = "rewind" | "osu" | "lazer";

export interface SkinId {
  source: SkinSource;
  name: string;
}

export function skinIdToString({ source, name }: SkinId) {
  return `${source}:${name}`;
}

const isSkinSource = (s: string): s is SkinSource => s === "rewind" || s === "osu" || s === "lazer";

export function stringToSkinId(str: string): SkinId {
  // Skin names of osu!lazer could also contain ":"
  const separatorIndex = str.indexOf(":");
  const source = str.substring(0, separatorIndex);
  const name = str.substring(separatorIndex + 1);
  if (isSkinSource(source)) {
    return { source, name };
  } else {
    throw Error("Skin source wrong");
  }
}

export const DEFAULT_OSU_SKIN_ID: SkinId = { source: "rewind", name: "OsuDefaultSkin" };
export const DEFAULT_REWIND_SKIN_ID: SkinId = { source: "rewind", name: "RewindDefaultSkin" };
