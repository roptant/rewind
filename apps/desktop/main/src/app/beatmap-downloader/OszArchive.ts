import AdmZip = require("adm-zip");
import { createHash } from "crypto";

export interface OszFileEntry {
  filename: string;
  sha256Hash: string;
  data: Buffer;
}

export interface ParsedOsuDifficulty {
  filename: string;
  md5Hash: string;
  sha256Hash: string;
  mode: number;
  onlineBeatmapId: number;
  onlineBeatmapSetId: number;
  title: string;
  titleUnicode: string;
  artist: string;
  artistUnicode: string;
  creator: string;
  difficultyName: string;
  source: string;
  tags: string;
  previewTime: number;
  audioFile: string;
  backgroundFile: string;
  beatDivisor: number;
  drainRate: number;
  circleSize: number;
  overallDifficulty: number;
  approachRate: number;
  sliderMultiplier: number;
  sliderTickRate: number;
  bpm: number;
  lengthMs: number;
  totalObjectCount: number;
  endTimeObjectCount: number;
}

export interface ParsedOszArchive {
  files: OszFileEntry[];
  difficulties: ParsedOsuDifficulty[];
  setHash: string;
}

const SECTION_HEADER_REGEX = /^\s*\[([^\]]+)]\s*$/;

function sha256Hex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function md5Hex(data: Buffer): string {
  return createHash("md5").update(data).digest("hex");
}

function isZipBuffer(buffer: Buffer): boolean {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05) &&
    (buffer[3] === 0x04 || buffer[3] === 0x06)
  );
}

function normalizeArchivePath(rawPath: string): string {
  return rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

function hasPathTraversal(normalizedPath: string): boolean {
  if (!normalizedPath || normalizedPath.includes("\0") || normalizedPath.includes(":")) {
    return true;
  }
  const segments = normalizedPath.split("/");
  return segments.some((seg) => seg === "" || seg === "." || seg === "..");
}

/**
 * Matches osu!lazer's `ArchiveReader.Filenames.GetCommonPrefix()` stripping when all archive entries
 * sit under a single root folder.
 */
function findCommonDirectoryPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  let prefix = paths[0];
  for (let i = 1; i < paths.length; i++) {
    const current = paths[i];
    let j = 0;
    const maxLen = Math.min(prefix.length, current.length);
    while (j < maxLen && prefix[j] === current[j]) {
      j++;
    }
    prefix = prefix.slice(0, j);
    if (!prefix) return "";
  }
  const lastSlash = prefix.lastIndexOf("/");
  return lastSlash >= 0 ? prefix.slice(0, lastSlash + 1) : "";
}

function splitKeyValue(line: string): [string, string] | null {
  const colonIdx = line.indexOf(":");
  if (colonIdx < 0) return null;
  return [line.slice(0, colonIdx).trim(), line.slice(colonIdx + 1).trim()];
}

function parseNumberOrDefault(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Parses an `.osu` beatmap file across all 4 osu! rulesets (osu, taiko, catch, mania)
 * to extract metadata, difficulty parameters, BPM, drain/full length, and object counts
 * matching `osu.Game.Beatmaps.BeatmapImporter`.
 */
export function parseOsuDifficulty(filename: string, data: Buffer): ParsedOsuDifficulty | null {
  const rawText = data.toString("utf-8").replace(/^\uFEFF/, "");
  const lines = rawText.split(/\r?\n/);
  if (lines.every((l) => l.trim() === "")) {
    return null;
  }

  let section = "";
  let mode = 0;
  let audioFile = "";
  let previewTime = -1;
  let beatDivisor = 4;

  let title = "";
  let titleUnicode: string | undefined;
  let artist = "";
  let artistUnicode: string | undefined;
  let creator = "";
  let difficultyName = "";
  let source = "";
  let tags = "";
  let onlineBeatmapId = -1;
  let onlineBeatmapSetId = -1;

  let drainRate = 5;
  let circleSize = 5;
  let overallDifficulty = 5;
  let approachRate: number | undefined;
  let sliderMultiplier = 1.4;
  let sliderTickRate = 1;
  let backgroundFile = "";

  interface TimingPoint {
    time: number;
    beatLength: number;
    uninherited: boolean;
  }
  const timingPoints: TimingPoint[] = [];

  interface HitObjSpan {
    startTime: number;
    type: number;
    endTimeHint?: number;
    slides?: number;
    pixelLength?: number;
  }
  const hitObjects: HitObjSpan[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    const sectionMatch = SECTION_HEADER_REGEX.exec(trimmed);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    switch (section) {
      case "General": {
        const kv = splitKeyValue(trimmed);
        if (!kv) break;
        const [k, v] = kv;
        if (k === "AudioFilename") audioFile = v;
        else if (k === "PreviewTime") previewTime = Math.trunc(parseNumberOrDefault(v, -1));
        else if (k === "Mode") mode = Math.trunc(parseNumberOrDefault(v, 0));
        break;
      }
      case "Editor": {
        const kv = splitKeyValue(trimmed);
        if (!kv) break;
        const [k, v] = kv;
        if (k === "BeatDivisor") beatDivisor = Math.max(1, Math.trunc(parseNumberOrDefault(v, 4)));
        break;
      }
      case "Metadata": {
        const kv = splitKeyValue(trimmed);
        if (!kv) break;
        const [k, v] = kv;
        if (k === "Title") title = v;
        else if (k === "TitleUnicode") titleUnicode = v;
        else if (k === "Artist") artist = v;
        else if (k === "ArtistUnicode") artistUnicode = v;
        else if (k === "Creator") creator = v;
        else if (k === "Version") difficultyName = v;
        else if (k === "Source") source = v;
        else if (k === "Tags") tags = v;
        else if (k === "BeatmapID") onlineBeatmapId = Math.trunc(parseNumberOrDefault(v, -1));
        else if (k === "BeatmapSetID") onlineBeatmapSetId = Math.trunc(parseNumberOrDefault(v, -1));
        break;
      }
      case "Difficulty": {
        const kv = splitKeyValue(trimmed);
        if (!kv) break;
        const [k, v] = kv;
        if (k === "HPDrainRate") drainRate = parseNumberOrDefault(v, 5);
        else if (k === "CircleSize") circleSize = parseNumberOrDefault(v, 5);
        else if (k === "OverallDifficulty") overallDifficulty = parseNumberOrDefault(v, 5);
        else if (k === "ApproachRate") approachRate = parseNumberOrDefault(v, overallDifficulty);
        else if (k === "SliderMultiplier") sliderMultiplier = parseNumberOrDefault(v, 1.4);
        else if (k === "SliderTickRate") sliderTickRate = parseNumberOrDefault(v, 1);
        break;
      }
      case "Events": {
        if (!backgroundFile && (trimmed.startsWith("0,0,") || trimmed.startsWith("Background,"))) {
          const parts = trimmed.split(",");
          if (parts.length >= 3) {
            backgroundFile = parts[2].trim().replace(/^"(.*)"$/, "$1");
          }
        }
        break;
      }
      case "TimingPoints": {
        const parts = trimmed.split(",");
        if (parts.length >= 2) {
          const time = parseNumberOrDefault(parts[0], 0);
          const beatLength = parseNumberOrDefault(parts[1], 1000);
          const uninherited = parts.length >= 7 ? parts[6].trim() !== "0" : beatLength > 0;
          timingPoints.push({ time, beatLength, uninherited });
        }
        break;
      }
      case "HitObjects": {
        const parts = trimmed.split(",");
        if (parts.length >= 4) {
          const startTime = parseNumberOrDefault(parts[2], 0);
          const type = Math.trunc(parseNumberOrDefault(parts[3], 1));
          const span: HitObjSpan = { startTime, type };
          if ((type & 2) !== 0 && parts.length >= 8) {
            // Slider: x,y,time,type,hitSound,curvePoints,slides,length
            span.slides = Math.max(1, Math.trunc(parseNumberOrDefault(parts[6], 1)));
            span.pixelLength = Math.max(0, parseNumberOrDefault(parts[7], 0));
          } else if ((type & 8) !== 0 && parts.length >= 6) {
            // Spinner: x,y,time,type,hitSound,endTime
            span.endTimeHint = parseNumberOrDefault(parts[5], startTime);
          } else if ((type & 128) !== 0 && parts.length >= 6) {
            // Mania hold: x,y,time,type,hitSound,endTime:hitSample
            const endToken = parts[5].split(":")[0];
            span.endTimeHint = parseNumberOrDefault(endToken, startTime);
          }
          hitObjects.push(span);
        }
        break;
      }
    }
  }

  timingPoints.sort((a, b) => a.time - b.time);
  const uninheritedPoints = timingPoints.filter((tp) => tp.uninherited && tp.beatLength > 0);

  const beatLengthAt = (time: number): { beatLength: number; speedMultiplier: number } => {
    let beatLength = uninheritedPoints[0]?.beatLength ?? 1000;
    let speedMultiplier = 1;
    for (const tp of timingPoints) {
      if (tp.time > time) break;
      if (tp.uninherited && tp.beatLength > 0) {
        beatLength = tp.beatLength;
        speedMultiplier = 1;
      } else if (!tp.uninherited && tp.beatLength < 0) {
        const clamped = Math.min(10000, Math.max(10, -tp.beatLength));
        speedMultiplier = 100 / clamped;
      }
    }
    return { beatLength, speedMultiplier };
  };

  let maxEndTime = 0;
  let endTimeObjectCount = 0;
  for (const obj of hitObjects) {
    let endTime = obj.startTime;
    if ((obj.type & 2) !== 0) {
      endTimeObjectCount++;
      const { beatLength, speedMultiplier } = beatLengthAt(obj.startTime);
      const velocity = (100 * sliderMultiplier * speedMultiplier) / beatLength;
      const spanDuration = velocity > 0 ? (obj.pixelLength ?? 0) / velocity : 0;
      endTime = obj.startTime + spanDuration * (obj.slides ?? 1);
    } else if ((obj.type & 8) !== 0) {
      endTimeObjectCount++;
      endTime = Math.max(obj.startTime, obj.endTimeHint ?? obj.startTime);
    } else if ((obj.type & 128) !== 0) {
      endTimeObjectCount++;
      endTime = Math.max(obj.startTime, obj.endTimeHint ?? obj.startTime);
    }
    if (endTime > maxEndTime) {
      maxEndTime = endTime;
    }
  }

  const lengthMs = hitObjects.length > 0 ? maxEndTime : 0;

  let bpm = 0;
  if (uninheritedPoints.length > 0) {
    const durationsByBeatLength = new Map<number, number>();
    for (let i = 0; i < uninheritedPoints.length; i++) {
      const current = uninheritedPoints[i];
      const nextTime = i + 1 < uninheritedPoints.length ? uninheritedPoints[i + 1].time : Math.max(lengthMs, current.time);
      const duration = Math.max(0, nextTime - current.time);
      const roundedBeatLength = Math.round(current.beatLength * 1000) / 1000;
      durationsByBeatLength.set(roundedBeatLength, (durationsByBeatLength.get(roundedBeatLength) ?? 0) + duration);
    }
    let bestBeatLength = uninheritedPoints[0].beatLength;
    let bestDuration = -1;
    for (const [bl, dur] of durationsByBeatLength.entries()) {
      if (dur > bestDuration) {
        bestDuration = dur;
        bestBeatLength = bl;
      }
    }
    bpm = bestBeatLength > 0 ? 60000 / bestBeatLength : 0;
  }

  return {
    filename,
    md5Hash: md5Hex(data),
    sha256Hash: sha256Hex(data),
    mode: mode >= 0 && mode <= 3 ? mode : 0,
    onlineBeatmapId: onlineBeatmapId > 0 ? onlineBeatmapId : -1,
    onlineBeatmapSetId: onlineBeatmapSetId > 0 ? onlineBeatmapSetId : -1,
    title,
    titleUnicode: titleUnicode ?? title,
    artist,
    artistUnicode: artistUnicode ?? artist,
    creator,
    difficultyName,
    source,
    tags,
    previewTime,
    audioFile,
    backgroundFile,
    beatDivisor,
    drainRate,
    circleSize,
    overallDifficulty,
    approachRate: approachRate ?? overallDifficulty,
    sliderMultiplier,
    sliderTickRate,
    bpm,
    lengthMs,
    totalObjectCount: hitObjects.length,
    endTimeObjectCount,
  };
}

/**
 * Parses and validates an `.osz` ZIP archive buffer, returning normalized file entries,
 * parsed top-level `.osu` difficulties, and the `osu!lazer` BeatmapSet SHA-256 hash.
 */
export function parseOszArchive(buffer: Buffer): ParsedOszArchive {
  if (!isZipBuffer(buffer)) {
    throw new Error("Downloaded file is not a valid .osz ZIP archive");
  }

  const zip = new AdmZip(buffer);
  const rawEntries = zip.getEntries().filter((e) => !e.isDirectory);
  if (rawEntries.length === 0) {
    throw new Error("The downloaded .osz archive is empty");
  }

  const normalizedPaths = rawEntries.map((e) => {
    const rawName = e.rawEntryName ? e.rawEntryName.toString("utf-8") : e.entryName;
    const normalized = normalizeArchivePath(rawName);
    if (hasPathTraversal(normalized)) {
      throw new Error(`Unsafe file path "${rawName}" in .osz archive`);
    }
    return normalized;
  });
  const commonPrefix = findCommonDirectoryPrefix(normalizedPaths);

  const seenLowerPaths = new Set<string>();
  const files: OszFileEntry[] = [];

  for (let i = 0; i < rawEntries.length; i++) {
    const shortened = normalizedPaths[i].slice(commonPrefix.length);
    if (hasPathTraversal(shortened)) {
      throw new Error(`Unsafe file path "${rawEntries[i].entryName}" in .osz archive`);
    }
    const lower = shortened.toLowerCase();
    if (seenLowerPaths.has(lower)) {
      continue;
    }
    seenLowerPaths.add(lower);

    const data = rawEntries[i].getData();
    files.push({
      filename: shortened,
      sha256Hash: sha256Hex(data),
      data,
    });
  }

  const seenOsuHashes = new Set<string>();
  const difficulties: ParsedOsuDifficulty[] = [];

  for (const file of files) {
    if (file.filename.includes("/") || !file.filename.toLowerCase().endsWith(".osu")) {
      continue;
    }
    if (seenOsuHashes.has(file.sha256Hash)) {
      continue;
    }
    const parsed = parseOsuDifficulty(file.filename, file.data);
    if (parsed) {
      seenOsuHashes.add(file.sha256Hash);
      difficulties.push(parsed);
    }
  }

  if (difficulties.length === 0) {
    throw new Error("No valid .osu beatmap files found in the .osz archive");
  }

  // Matches osu!lazer's `RealmArchiveModelImporter.ComputeHash` with `HashableFileTypes = [".osu"]`
  const sortedOsuFiles = files
    .filter((f) => f.filename.toLowerCase().endsWith(".osu"))
    .slice()
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));

  const setHasher = createHash("sha256");
  for (const osuFile of sortedOsuFiles) {
    setHasher.update(osuFile.data);
  }
  const setHash = setHasher.digest("hex");

  return {
    files,
    difficulties,
    setHash,
  };
}
