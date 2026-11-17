import { mkdir, utimes, writeFile } from "fs/promises";
import { dirname, resolve, sep } from "path";
import { ParsedOszArchive } from "./OszArchive";

// Characters disallowed in Windows/POSIX folder names
// eslint-disable-next-line no-control-regex
const INVALID_FOLDER_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

export function sanitizeBeatmapFolderName(rawName: string): string {
  const cleaned = rawName
    .replace(INVALID_FOLDER_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return cleaned || "beatmap";
}

/**
 * Extracts a parsed `.osz` archive into an `osu!stable` `Songs/` folder (or Rewind's local beatmap cache folder).
 * Updates modification timestamps so `BlueprintLocatorService` immediately discovers the new `.osu` files
 * without requiring `osu!stable` to open or flush `osu!.db`.
 */
export async function importOszToFolder(
  archive: ParsedOszArchive,
  songsFolder: string,
  preferredSetId?: number,
): Promise<string> {
  const firstDiff = archive.difficulties[0];
  const setId = preferredSetId && preferredSetId > 0 ? preferredSetId : firstDiff.onlineBeatmapSetId;
  const baseLabel = [firstDiff.artist, firstDiff.title].filter(Boolean).join(" - ") || "Imported Beatmap";
  const folderName = sanitizeBeatmapFolderName(setId > 0 ? `${setId} ${baseLabel}` : baseLabel);

  const rootTarget = resolve(songsFolder, folderName);
  await mkdir(rootTarget, { recursive: true });

  for (const file of archive.files) {
    const destPath = resolve(rootTarget, ...file.filename.split("/"));
    if (destPath !== rootTarget && !destPath.startsWith(rootTarget + sep)) {
      throw new Error(`Refusing to write "${file.filename}" outside target beatmap directory`);
    }
    await mkdir(dirname(destPath), { recursive: true });
    await writeFile(destPath, file.data);
  }

  const now = new Date();
  await utimes(rootTarget, now, now).catch(() => undefined);
  await utimes(songsFolder, now, now).catch(() => undefined);

  return folderName;
}
