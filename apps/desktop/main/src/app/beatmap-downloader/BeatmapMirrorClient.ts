import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { BeatmapMirrorId, RemoteBeatmapMetadata } from "./types";

const MAX_REDIRECTS = 6;
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_OSZ_BYTES = 512 * 1024 * 1024; // 512 MiB safety cap

export interface HttpResponseBuffer {
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export interface StreamDownloadOptions {
  userAgent: string;
  timeoutMs?: number;
  onProgress?: (transferredBytes: number, totalBytes?: number) => void;
}

const STATUS_NAME_TO_INT: Record<string, number> = {
  graveyard: -2,
  wip: -1,
  pending: 0,
  ranked: 1,
  approved: 2,
  qualified: 3,
  loved: 4,
};

function parseOnlineStatus(raw: unknown): number {
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= -4 && raw <= 4) {
    return raw;
  }
  if (typeof raw === "string") {
    const lower = raw.toLowerCase();
    if (lower in STATUS_NAME_TO_INT) {
      return STATUS_NAME_TO_INT[lower];
    }
    const asNum = Number(raw);
    if (Number.isInteger(asNum) && asNum >= -4 && asNum <= 4) {
      return asNum;
    }
  }
  return -3;
}

export function httpGetBuffer(
  rawUrl: string,
  options: StreamDownloadOptions,
  redirectCount = 0,
): Promise<HttpResponseBuffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch (err) {
      rejectPromise(new Error(`Invalid URL "${rawUrl}": ${String(err)}`));
      return;
    }

    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      rejectPromise(new Error(`Unsupported URL protocol "${parsedUrl.protocol}"`));
      return;
    }

    const transport = parsedUrl.protocol === "https:" ? https : http;
    const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;

    const req = transport.get(
      parsedUrl,
      {
        headers: {
          "User-Agent": options.userAgent,
          Accept: "application/json, application/x-osu-beatmap-archive, application/octet-stream, */*",
        },
      },
      (res) => {
        const statusCode = res.statusCode ?? 0;
        const location = res.headers.location;

        if ([301, 302, 303, 307, 308].includes(statusCode) && location) {
          res.resume();
          if (redirectCount >= MAX_REDIRECTS) {
            rejectPromise(new Error(`Too many HTTP redirects while requesting ${rawUrl}`));
            return;
          }
          const nextUrl = new URL(location, parsedUrl).toString();
          resolvePromise(httpGetBuffer(nextUrl, options, redirectCount + 1));
          return;
        }

        const contentLengthHeader = res.headers["content-length"];
        const parsedLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
        const totalBytes = Number.isFinite(parsedLength) && parsedLength > 0 ? parsedLength : undefined;

        const chunks: Buffer[] = [];
        let transferred = 0;
        let lastProgressEmit = 0;

        res.on("data", (chunk: Buffer) => {
          transferred += chunk.length;
          if (transferred > MAX_OSZ_BYTES) {
            req.destroy(new Error(`Response exceeded maximum allowed size (${MAX_OSZ_BYTES} bytes)`));
            return;
          }
          chunks.push(chunk);
          if (options.onProgress) {
            const now = Date.now();
            if (now - lastProgressEmit >= 80 || (totalBytes && transferred >= totalBytes)) {
              lastProgressEmit = now;
              options.onProgress(transferred, totalBytes);
            }
          }
        });

        res.on("end", () => {
          if (options.onProgress && transferred > 0) {
            options.onProgress(transferred, totalBytes);
          }
          resolvePromise({
            statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });

        res.on("error", (err) => {
          rejectPromise(err);
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms (${rawUrl})`));
    });

    req.on("error", (err) => {
      rejectPromise(err);
    });
  });
}

function asRecord(val: unknown): Record<string, unknown> | undefined {
  return typeof val === "object" && val !== null ? (val as Record<string, unknown>) : undefined;
}

function asPositiveInt(val: unknown): number {
  const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
  return Number.isInteger(n) && n > 0 ? n : -1;
}

function asStringOrEmpty(val: unknown): string {
  return typeof val === "string" ? val : "";
}

export function parseMirrorBeatmapMetadata(md5: string, json: unknown): RemoteBeatmapMetadata | null {
  const obj = asRecord(json);
  if (!obj) return null;

  const setObj = asRecord(obj.beatmapset) ?? asRecord(obj.set);
  const beatmapSetId = asPositiveInt(obj.beatmapset_id ?? setObj?.id ?? obj.ParentSetID ?? obj.BeatmapSetID);
  if (beatmapSetId <= 0) {
    return null;
  }

  const beatmapId = asPositiveInt(obj.id ?? obj.beatmap_id ?? obj.BeatmapID);
  const title = asStringOrEmpty(setObj?.title ?? obj.title ?? obj.Title);
  const artist = asStringOrEmpty(setObj?.artist ?? obj.artist ?? obj.Artist);
  const creator = asStringOrEmpty(setObj?.creator ?? obj.creator ?? obj.Creator);
  const difficultyName = asStringOrEmpty(obj.version ?? obj.DiffName ?? obj.DifficultyName);
  const status = parseOnlineStatus(obj.ranked ?? obj.status ?? setObj?.ranked ?? setObj?.status ?? obj.RankedStatus);

  return {
    md5: md5.toLowerCase(),
    beatmapId,
    beatmapSetId,
    title,
    artist,
    creator,
    difficultyName,
    status,
  };
}

const MD5_LOOKUP_ENDPOINTS: Array<{ name: string; buildUrl: (md5: string) => string }> = [
  { name: "catboy.best", buildUrl: (md5) => `https://catboy.best/api/v2/md5/${md5}` },
  { name: "osu.direct", buildUrl: (md5) => `https://osu.direct/api/v2/md5/${md5}` },
];

export const MIRROR_DISPLAY_NAMES: Record<BeatmapMirrorId, string> = {
  catboy: "catboy.best",
  nerinyan: "Nerinyan",
  osudirect: "osu.direct",
};

export function buildMirrorDownloadUrl(mirror: BeatmapMirrorId, beatmapSetId: number, noVideo: boolean): string {
  switch (mirror) {
    case "catboy":
      return `https://catboy.best/d/${beatmapSetId}${noVideo ? "n" : ""}`;
    case "nerinyan":
      return `https://api.nerinyan.moe/d/${beatmapSetId}${noVideo ? "?noVideo=1" : ""}`;
    case "osudirect":
      return `https://osu.direct/api/d/${beatmapSetId}${noVideo ? "?noVideo=1" : ""}`;
  }
}

export function orderedMirrors(preferred: BeatmapMirrorId): BeatmapMirrorId[] {
  const all: BeatmapMirrorId[] = ["catboy", "nerinyan", "osudirect"];
  return [preferred, ...all.filter((m) => m !== preferred)];
}

export class BeatmapMirrorClient {
  constructor(
    private readonly userAgent: string,
    private readonly fetcher: typeof httpGetBuffer = httpGetBuffer,
  ) {}

  async lookupByMd5(md5: string): Promise<RemoteBeatmapMetadata> {
    const cleanMd5 = md5.trim().toLowerCase();
    if (!/^[a-f0-9]{32}$/.test(cleanMd5)) {
      throw new Error(`Invalid beatmap MD5 hash "${md5}"`);
    }

    const errors: string[] = [];
    let notFoundCount = 0;

    for (const endpoint of MD5_LOOKUP_ENDPOINTS) {
      try {
        const res = await this.fetcher(endpoint.buildUrl(cleanMd5), {
          userAgent: this.userAgent,
          timeoutMs: 12_000,
        });
        if (res.statusCode === 404) {
          notFoundCount++;
          continue;
        }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          errors.push(`${endpoint.name} returned HTTP ${res.statusCode}`);
          continue;
        }
        const parsedJson = JSON.parse(res.body.toString("utf-8")) as unknown;
        const metadata = parseMirrorBeatmapMetadata(cleanMd5, parsedJson);
        if (metadata) {
          return metadata;
        }
        errors.push(`${endpoint.name} returned unrecognized beatmap metadata`);
      } catch (err) {
        errors.push(`${endpoint.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (notFoundCount === MD5_LOOKUP_ENDPOINTS.length) {
      throw new Error(
        `Beatmap (MD5=${cleanMd5}) was not found on any beatmap mirror. It may be unsubmitted or locally modified.`,
      );
    }

    throw new Error(
      `Could not look up beatmap (MD5=${cleanMd5}) on mirrors (${errors.join("; ") || "unknown error"})`,
    );
  }

  async downloadOsz(
    beatmapSetId: number,
    options: {
      preferredMirror: BeatmapMirrorId;
      noVideo: boolean;
      validateArchive?: (buffer: Buffer) => void;
      onMirrorProgress?: (mirrorName: string, transferredBytes: number, totalBytes?: number) => void;
    },
  ): Promise<{ buffer: Buffer; mirrorName: string }> {
    const mirrors = orderedMirrors(options.preferredMirror);
    const videoModes = options.noVideo ? [true, false] : [false];
    const errors: string[] = [];

    for (const noVideo of videoModes) {
      for (const mirrorId of mirrors) {
        const mirrorName = MIRROR_DISPLAY_NAMES[mirrorId];
        const url = buildMirrorDownloadUrl(mirrorId, beatmapSetId, noVideo);
        try {
          const res = await this.fetcher(url, {
            userAgent: this.userAgent,
            onProgress: (transferred, total) => options.onMirrorProgress?.(mirrorName, transferred, total),
          });
          if (res.statusCode < 200 || res.statusCode >= 300) {
            errors.push(`${mirrorName} returned HTTP ${res.statusCode}`);
            continue;
          }
          if (options.validateArchive) {
            options.validateArchive(res.body);
          }
          return { buffer: res.body, mirrorName };
        } catch (err) {
          errors.push(`${mirrorName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // Only retry with video if every mirror failed in noVideo mode because of 404/invalid archive
    }

    throw new Error(`Failed to download beatmap set #${beatmapSetId} from mirrors (${errors.join("; ")})`);
  }
}
