import { spawn } from "child_process";
import { execFile } from "child_process";
import { access, copyFile, mkdir, readdir, readFile, readlink, rename, unlink, writeFile } from "fs/promises";
import { constants as fsConstants } from "fs";
import { delimiter, dirname, join, resolve } from "path";
import { promisify } from "util";
import { LazerDBReader, lazerFilePath } from "@rewind/osu-local/db-reader";
import { ParsedOszArchive, ParsedOsuDifficulty } from "./OszArchive";
import { RemoteBeatmapMetadata } from "./types";

const execFileAsync = promisify(execFile);

declare const __non_webpack_require__: NodeRequire | undefined;

const RESULT_PREFIX = "REWIND_REALM_RESULT:";
const SUBPROCESS_TIMEOUT_MS = 30_000;

export class LazerRealmLockedError extends Error {
  constructor(message = "osu!lazer is currently running and holding client.realm open") {
    super(message);
    this.name = "LazerRealmLockedError";
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether another process (such as a running `osu!lazer` instance) currently holds
 * `client.realm` or `client.realm.lock` open.
 * Note: `client.realm.lock` remains on disk even when osu!lazer is closed, so we check active open handles/locks.
 */
export async function isLazerRealmLocked(lazerFolder: string): Promise<boolean> {
  const realmPath = resolve(lazerFolder, "client.realm");
  const lockPath = resolve(lazerFolder, "client.realm.lock");

  if (!(await fileExists(realmPath))) {
    throw new Error(`osu!lazer database not found at ${realmPath}`);
  }

  const selfPid = String(process.pid);

  if (process.platform === "linux") {
    try {
      const entries = await readdir("/proc");
      for (const entry of entries) {
        if (!/^\d+$/.test(entry) || entry === selfPid) continue;
        const fdDir = `/proc/${entry}/fd`;
        let fds: string[];
        try {
          fds = await readdir(fdDir);
        } catch {
          continue;
        }
        for (const fd of fds) {
          try {
            const target = await readlink(`${fdDir}/${fd}`);
            if (target === realmPath || target === lockPath) {
              return true;
            }
          } catch {
            // Ignore disappeared fds
          }
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  if (process.platform === "darwin") {
    try {
      const targets = [realmPath];
      if (await fileExists(lockPath)) targets.push(lockPath);
      const { stdout } = await execFileAsync("lsof", ["-F", "p", "--", ...targets]);
      const pids = stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("p"))
        .map((line) => line.slice(1).trim())
        .filter((pid) => pid && pid !== selfPid);
      return pids.length > 0;
    } catch {
      // lsof exits with code 1 when no process has the file open
      return false;
    }
  }

  if (process.platform === "win32") {
    if (await fileExists(lockPath)) {
      const probePath = `${lockPath}.rewind-probe.${process.pid}`;
      try {
        // When osu!lazer has client.realm open on Windows, Realm Core holds client.realm.lock without
        // FILE_SHARE_DELETE, so renaming it fails with EBUSY/EPERM/EACCES. Avoid checking tasklist for
        // "osu!.exe" because osu!stable uses the same executable name on Windows.
        await rename(lockPath, probePath);
        await rename(probePath, lockPath);
      } catch (err: unknown) {
        await rename(probePath, lockPath).catch(() => undefined);
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
          return true;
        }
      }
    }
  }

  return false;
}

function resolveRealmPaths(): { realmModulePath: string; nodeModulesPaths: string[] } {
  const req: NodeRequire = typeof __non_webpack_require__ !== "undefined" ? __non_webpack_require__ : require;
  const pkgJsonPath = req.resolve("realm/package.json");
  const asarRealmDir = dirname(pkgJsonPath);
  // In packaged Electron builds with asarUnpack, load from app.asar.unpacked so the native .node binary is accessible,
  // while keeping both app.asar.unpacked/node_modules and app.asar/node_modules on NODE_PATH for transitive dependencies.
  const unpackedRealmDir = asarRealmDir.replace(/app\.asar([/\\])/, "app.asar.unpacked$1");
  const nodeModulesPaths = Array.from(new Set([dirname(unpackedRealmDir), dirname(asarRealmDir)]));
  return {
    realmModulePath: unpackedRealmDir,
    nodeModulesPaths,
  };
}

interface WorkerFileEntry {
  filename: string;
  sha256Hash: string;
}

interface WorkerPayload {
  realmModulePath: string;
  nodeModulesPaths: string[];
  realmPath: string;
  setHash: string;
  onlineSetId: number;
  status: number;
  files: WorkerFileEntry[];
  difficulties: ParsedOsuDifficulty[];
}

interface WorkerResult {
  ok: boolean;
  action?: "imported" | "reused" | "restored";
  importedMd5s?: string[];
  error?: string;
}

/**
 * Self-contained JS worker executed in a short-lived `ELECTRON_RUN_AS_NODE=1` child process.
 * Running Realm in an isolated short-lived process guarantees every OS file descriptor, mmap region,
 * and Realm lock on `client.realm` is 100% released the moment the import finishes, so `osu!lazer`
 * can be launched immediately afterward without lock contention.
 */
const REALM_IMPORT_WORKER_SCRIPT = `
"use strict";
// Electron 19 embeds Node 16 where globalThis.fetch is undefined; @realm/fetch only uses it for Atlas Sync.
globalThis.fetch = globalThis.fetch || (() => Promise.reject(new Error("Network disabled in offline Realm worker")));
const pathMod = require("path");
const Module = require("module");

const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", async () => {
  let realm;
  try {
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
    if (Array.isArray(payload.nodeModulesPaths) && payload.nodeModulesPaths.length > 0) {
      const existing = process.env.NODE_PATH ? process.env.NODE_PATH.split(pathMod.delimiter).filter(Boolean) : [];
      process.env.NODE_PATH = Array.from(new Set([...payload.nodeModulesPaths, ...existing])).join(pathMod.delimiter);
      Module._initPaths();
    }
    const Realm = require(payload.realmModulePath);
    const UUID = Realm.BSON.UUID;

    // Open dynamically (without passing schema/schemaVersion) so client.realm keeps its exact live schemaVersion
    // and column definitions without triggering any schema migration.
    realm = new Realm({ path: payload.realmPath });

    const schemaByName = new Map(realm.schema.map((s) => [s.name, s]));
    const pickProps = (className, values) => {
      const modelSchema = schemaByName.get(className);
      if (!modelSchema) {
        throw new Error("Missing expected table '" + className + "' in client.realm");
      }
      const out = {};
      for (const [propName, propDef] of Object.entries(modelSchema.properties)) {
        if (Object.prototype.hasOwnProperty.call(values, propName)) {
          out[propName] = values[propName];
          continue;
        }
        if (propDef.type === "linkingObjects") {
          continue;
        }
        if (propDef.type === "list") {
          out[propName] = [];
          continue;
        }
        if (propDef.optional) {
          out[propName] = null;
          continue;
        }
        switch (propDef.type) {
          case "int":
          case "float":
          case "double":
            out[propName] = 0;
            break;
          case "bool":
            out[propName] = false;
            break;
          case "string":
            out[propName] = "";
            break;
          case "date":
            out[propName] = new Date();
            break;
          case "uuid":
            out[propName] = new UUID();
            break;
          default:
            break;
        }
      }
      return out;
    };

    let action = "imported";
    const importedMd5s = [];

    realm.write(() => {
      const fileByHash = new Map();
      for (const f of payload.files) {
        if (!fileByHash.has(f.sha256Hash)) {
          const managedFile = realm.create("File", { Hash: f.sha256Hash }, "modified");
          fileByHash.set(f.sha256Hash, managedFile);
        }
      }

      const existingSets = realm
        .objects("BeatmapSet")
        .filtered("Hash == $0", payload.setHash)
        .sorted("DeletePending", false);

      if (existingSets.length > 0) {
        const candidate = existingSets[0];
        if (candidate.Beatmaps && candidate.Beatmaps.length > 0) {
          if (candidate.DeletePending) {
            candidate.DeletePending = false;
            candidate.DateAdded = new Date();
            action = "restored";
          } else {
            action = "reused";
          }
          for (const b of candidate.Beatmaps) {
            if (b.MD5Hash) importedMd5s.push(b.MD5Hash);
          }
          return;
        }
        candidate.DeletePending = true;
      }

      // PreImport: disassociate any older BeatmapSet sharing the same OnlineID (matches BeatmapImporter.PreImport)
      if (payload.onlineSetId > 0) {
        const sameOnlineSets = realm.objects("BeatmapSet").filtered("OnlineID == $0", payload.onlineSetId);
        for (const oldSet of sameOnlineSets) {
          oldSet.DeletePending = true;
          oldSet.OnlineID = -1;
          if (oldSet.Beatmaps) {
            for (const oldMap of oldSet.Beatmaps) {
              oldMap.OnlineID = -1;
              if ("OnlineMD5Hash" in oldMap) oldMap.OnlineMD5Hash = "";
              if ("LastOnlineUpdate" in oldMap) oldMap.LastOnlineUpdate = null;
              if ("Status" in oldMap && oldMap.Status !== -4) oldMap.Status = -3;
            }
          }
        }
      }

      // Validate Beatmap OnlineIDs for uniqueness (matches BeatmapImporter.validateOnlineIds)
      const positiveIds = payload.difficulties.map((d) => d.onlineBeatmapId).filter((id) => id > 0);
      let resetBeatmapOnlineIds = new Set(positiveIds).size !== positiveIds.length;
      if (!resetBeatmapOnlineIds) {
        for (const id of positiveIds) {
          const conflicting = realm.objects("Beatmap").filtered("OnlineID == $0", id);
          if (conflicting.length > 0) {
            resetBeatmapOnlineIds = true;
            break;
          }
        }
      }

      const hadOnlineIds = positiveIds.length > 0;
      const effectiveSetOnlineId = hadOnlineIds && resetBeatmapOnlineIds ? -1 : payload.onlineSetId;

      const createdBeatmaps = [];
      for (const diff of payload.difficulties) {
        const ruleset = realm.objects("Ruleset").filtered("OnlineID == $0", diff.mode)[0];
        if (!ruleset || ruleset.Available === false) {
          continue;
        }

        const metadataObj = realm.create(
          "BeatmapMetadata",
          pickProps("BeatmapMetadata", {
            Title: diff.title,
            TitleUnicode: diff.titleUnicode,
            Artist: diff.artist,
            ArtistUnicode: diff.artistUnicode,
            Author: pickProps("RealmUser", {
              OnlineID: 1,
              Username: diff.creator,
              CountryCode: "",
            }),
            Source: diff.source,
            Tags: diff.tags,
            UserTags: [],
            PreviewTime: diff.previewTime,
            AudioFile: diff.audioFile,
            BackgroundFile: diff.backgroundFile,
          }),
        );

        const onlineId = resetBeatmapOnlineIds ? -1 : diff.onlineBeatmapId;
        const beatmapObj = realm.create(
          "Beatmap",
          pickProps("Beatmap", {
            ID: new UUID(),
            DifficultyName: diff.difficultyName,
            Ruleset: ruleset,
            Difficulty: pickProps("BeatmapDifficulty", {
              DrainRate: diff.drainRate,
              CircleSize: diff.circleSize,
              OverallDifficulty: diff.overallDifficulty,
              ApproachRate: diff.approachRate,
              SliderMultiplier: diff.sliderMultiplier,
              SliderTickRate: diff.sliderTickRate,
            }),
            Metadata: metadataObj,
            UserSettings: pickProps("BeatmapUserSettings", { Offset: 0 }),
            BeatmapSet: null,
            Status: onlineId > 0 ? payload.status : -3,
            OnlineID: onlineId,
            Length: diff.lengthMs,
            BPM: diff.bpm,
            Hash: diff.sha256Hash,
            // -1 instructs osu!lazer's BackgroundDataStoreProcessor to compute exact local StarRating on next launch
            StarRating: -1,
            MD5Hash: diff.md5Hash,
            OnlineMD5Hash: onlineId > 0 ? diff.md5Hash : "",
            LastLocalUpdate: null,
            LastOnlineUpdate: onlineId > 0 ? new Date() : null,
            Hidden: false,
            EndTimeObjectCount: diff.endTimeObjectCount,
            TotalObjectCount: diff.totalObjectCount,
            LastPlayed: null,
            BeatDivisor: diff.beatDivisor,
            EditorTimestamp: null,
          }),
        );

        createdBeatmaps.push(beatmapObj);
        importedMd5s.push(diff.md5Hash);
      }

      if (createdBeatmaps.length === 0) {
        throw new Error("No beatmap difficulties with an available osu!lazer ruleset could be imported");
      }

      const fileUsages = payload.files.map((f) =>
        pickProps("RealmNamedFileUsage", {
          File: fileByHash.get(f.sha256Hash),
          Filename: f.filename,
        }),
      );

      const beatmapSetObj = realm.create(
        "BeatmapSet",
        pickProps("BeatmapSet", {
          ID: new UUID(),
          OnlineID: effectiveSetOnlineId > 0 ? effectiveSetOnlineId : -1,
          DateAdded: new Date(),
          DateSubmitted: null,
          DateRanked: null,
          Beatmaps: createdBeatmaps,
          Files: fileUsages,
          Status: effectiveSetOnlineId > 0 ? payload.status : -3,
          DeletePending: false,
          Hash: payload.setHash,
          Protected: false,
        }),
      );

      for (const b of createdBeatmaps) {
        b.BeatmapSet = beatmapSetObj;
        // Reattach any detached local scores matching BeatmapHash (matches BeatmapInfo.UpdateLocalScores)
        if (schemaByName.has("Score")) {
          const scoreProps = schemaByName.get("Score").properties;
          if (scoreProps.BeatmapHash && scoreProps.BeatmapInfo) {
            const matchingScores = realm.objects("Score").filtered("BeatmapHash == $0", b.Hash);
            for (const s of matchingScores) {
              if (!s.BeatmapInfo) s.BeatmapInfo = b;
            }
          }
        }
      }
    });

    realm.close();
    realm = undefined;
    process.stdout.write("${RESULT_PREFIX}" + JSON.stringify({ ok: true, action, importedMd5s }) + "\\n", () => {
      process.exit(0);
    });
  } catch (err) {
    try {
      if (realm) realm.close();
    } catch (_) {}
    const msg = err && err.stack ? err.stack : String(err);
    process.stdout.write("${RESULT_PREFIX}" + JSON.stringify({ ok: false, error: msg }) + "\\n", () => {
      process.exit(1);
    });
  }
});
`;

function runRealmWorker(payload: WorkerPayload): Promise<WorkerResult> {
  const mergedNodePath = Array.from(
    new Set([
      ...payload.nodeModulesPaths,
      ...(process.env.NODE_PATH ? process.env.NODE_PATH.split(delimiter).filter(Boolean) : []),
    ]),
  ).join(delimiter);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["-e", REALM_IMPORT_WORKER_SCRIPT], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        NODE_PATH: mergedNodePath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        rejectPromise(new Error(`Offline Realm import timed out after ${SUBPROCESS_TIMEOUT_MS}ms`));
      }
    }, SUBPROCESS_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        rejectPromise(err);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);

      const line = stdout
        .split(/\r?\n/)
        .find((l) => l.startsWith(RESULT_PREFIX));
      if (line) {
        try {
          const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as WorkerResult;
          if (parsed.ok) {
            resolvePromise(parsed);
          } else {
            rejectPromise(new Error(parsed.error || "Offline Realm worker failed"));
          }
          return;
        } catch (err) {
          rejectPromise(new Error(`Invalid worker JSON output: ${String(err)}`));
          return;
        }
      }
      rejectPromise(
        new Error(
          `Offline Realm worker exited with code ${code}${stderr ? `: ${stderr.trim()}` : stdout ? `: ${stdout.trim()}` : ""}`,
        ),
      );
    });

    child.stdin.end(JSON.stringify(payload));
  });
}

async function writeArchiveFilesToLazerStore(archive: ParsedOszArchive, lazerFolder: string): Promise<void> {
  for (const file of archive.files) {
    const relPath = lazerFilePath(file.sha256Hash);
    const destPath = join(lazerFolder, relPath);
    if (await fileExists(destPath)) {
      continue;
    }
    await mkdir(dirname(destPath), { recursive: true });
    const tmpPath = `${destPath}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tmpPath, file.data);
    try {
      await rename(tmpPath, destPath);
    } catch (err) {
      await unlink(tmpPath).catch(() => undefined);
      if (!(await fileExists(destPath))) {
        throw err;
      }
    }
  }
}

/**
 * Imports a parsed `.osz` archive directly into `osu!lazer`'s hashed `files/` store and `client.realm`
 * without opening `osu!lazer`.
 *
 * Safety guarantees:
 * 1. Refuses to write (`LazerRealmLockedError`) if `osu!lazer` currently holds `client.realm` open.
 * 2. Backs up `client.realm` to `client.realm.rewind.bak` prior to opening.
 * 3. Runs the Realm transaction in an isolated short-lived child process using dynamic schema mode.
 * 4. Verifies readability afterward using Rewind's independent `LazerDBReader` and restores the backup on any failure.
 */
export async function importOszToLazerOffline(
  archive: ParsedOszArchive,
  lazerFolder: string,
  options?: {
    targetMd5?: string;
    onlineMetadata?: RemoteBeatmapMetadata;
  },
): Promise<void> {
  if (await isLazerRealmLocked(lazerFolder)) {
    throw new LazerRealmLockedError();
  }

  await writeArchiveFilesToLazerStore(archive, lazerFolder);

  const realmPath = join(lazerFolder, "client.realm");
  const backupPath = join(lazerFolder, "client.realm.rewind.bak");
  await copyFile(realmPath, backupPath);

  const onlineSetId =
    options?.onlineMetadata?.beatmapSetId && options.onlineMetadata.beatmapSetId > 0
      ? options.onlineMetadata.beatmapSetId
      : archive.difficulties[0]?.onlineBeatmapSetId ?? -1;

  const status = options?.onlineMetadata?.status ?? -3;

  const { realmModulePath, nodeModulesPaths } = resolveRealmPaths();

  try {
    await runRealmWorker({
      realmModulePath,
      nodeModulesPaths,
      realmPath,
      setHash: archive.setHash,
      onlineSetId,
      status,
      files: archive.files.map((f) => ({ filename: f.filename, sha256Hash: f.sha256Hash })),
      difficulties: archive.difficulties,
    });

    // Self-verify with Rewind's pure-TypeScript binary Realm reader
    const realmBuffer = await readFile(realmPath);
    const beatmaps = new LazerDBReader(realmBuffer).readBeatmaps();
    if (options?.targetMd5) {
      const found = beatmaps.some((b) => b.md5Hash === options.targetMd5);
      if (!found) {
        throw new Error(
          `Post-import verification failed: beatmap MD5 ${options.targetMd5} was not found in client.realm`,
        );
      }
    }
  } catch (err) {
    // Restore clean pre-import snapshot if anything failed
    await copyFile(backupPath, realmPath).catch((restoreErr) => {
      console.error("Failed to restore client.realm backup after error", restoreErr);
    });
    throw err;
  }
}
