import AdmZip = require("adm-zip");
import { createHash } from "crypto";
import { mkdtemp, readFile, rm, stat } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { LazerDBReader, lazerFilePath } from "@rewind/osu-local/db-reader";
import { parseOszArchive } from "./OszArchive";
import { importOszToFolder, sanitizeBeatmapFolderName } from "./StableBeatmapImporter";
import { importOszToLazerOffline } from "./LazerRealmImporter";
import { BeatmapMirrorClient, HttpResponseBuffer } from "./BeatmapMirrorClient";
import { BeatmapDownloadService } from "./BeatmapDownloadService";
import { BeatmapDownloadProgressEvent } from "./types";

const SAMPLE_OSU_INSANE = `osu file format v14

[General]
AudioFilename: audio.mp3
AudioLeadIn: 0
PreviewTime: 42150
Mode: 0

[Editor]
BeatDivisor: 4

[Metadata]
Title:Re:TrymenT: Story
TitleUnicode:Re:TrymenT: ストーリー
Artist:Camellia
ArtistUnicode:かめりあ
Creator:TestMapper
Version:Insane
Source:TestSource
Tags:tech speed
BeatmapID:222001
BeatmapSetID:111000

[Difficulty]
HPDrainRate:5.5
CircleSize:4
OverallDifficulty:8.5
ApproachRate:9.3
SliderMultiplier:1.8
SliderTickRate:1

[Events]
0,0,"bg.jpg",0,0

[TimingPoints]
0,300,4,2,1,60,1,0
1000,-50,4,2,1,60,0,0

[HitObjects]
256,192,1000,1,0,0:0:0:0:
120,160,1500,2,0,L|220:160,2,180
256,192,3000,12,0,4500,0:0:0:0:
`;

const SAMPLE_OSU_HARD = `osu file format v14

[General]
AudioFilename: audio.mp3
Mode: 0

[Metadata]
Title:Re:TrymenT: Story
Artist:Camellia
Creator:TestMapper
Version:Hard
BeatmapID:222002
BeatmapSetID:111000

[Difficulty]
HPDrainRate:4
CircleSize:4
OverallDifficulty:7
SliderMultiplier:1.4
SliderTickRate:1

[Events]
0,0,"bg.jpg",0,0

[TimingPoints]
0,400,4,2,1,60,1,0

[HitObjects]
256,192,500,1,0,0:0:0:0:
`;

function md5(content: string | Buffer): string {
  return createHash("md5").update(content).digest("hex");
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function buildSampleOszBuffer(prefix = ""): Buffer {
  const zip = new AdmZip();
  zip.addFile(`${prefix}Camellia - Re_TrymenT (TestMapper) [Insane].osu`, Buffer.from(SAMPLE_OSU_INSANE, "utf-8"));
  zip.addFile(`${prefix}Camellia - Re_TrymenT (TestMapper) [Hard].osu`, Buffer.from(SAMPLE_OSU_HARD, "utf-8"));
  zip.addFile(`${prefix}audio.mp3`, Buffer.from("FAKE_MP3_CONTENT"));
  zip.addFile(`${prefix}bg.jpg`, Buffer.from("FAKE_JPG_CONTENT"));
  zip.addFile(`${prefix}sb/glow.png`, Buffer.from("FAKE_SB_CONTENT"));
  return zip.toBuffer();
}

/**
 * Creates a real osu!lazer v52 `client.realm` file in an isolated child process so no open Realm handles
 * linger in the Jest process (matching real offline state when osu!lazer is closed).
 */
function createSeedLazerRealm(realmPath: string, orphanScoreBeatmapSha256?: string): Promise<void> {
  const realmPkgDir = require.resolve("realm/package.json").replace(/[/\\]package\.json$/, "");
  const seedScript = `
    globalThis.fetch = globalThis.fetch || (() => Promise.reject(new Error("offline")));
    const Realm = require(${JSON.stringify(realmPkgDir)});
    const UUID = Realm.BSON.UUID;
    const schema = [
      {
        name: "File",
        primaryKey: "Hash",
        properties: { Hash: "string?" },
      },
      {
        name: "RealmNamedFileUsage",
        embedded: true,
        properties: { File: "File", Filename: "string?" },
      },
      {
        name: "RealmUser",
        embedded: true,
        properties: { OnlineID: "int", Username: "string?", CountryCode: "string?" },
      },
      {
        name: "Ruleset",
        primaryKey: "ShortName",
        properties: {
          ShortName: "string?",
          OnlineID: { type: "int", indexed: true },
          Name: "string?",
          InstantiationInfo: "string?",
          LastAppliedDifficultyVersion: "int",
          Available: "bool",
        },
      },
      {
        name: "BeatmapDifficulty",
        embedded: true,
        properties: {
          DrainRate: "float",
          CircleSize: "float",
          OverallDifficulty: "float",
          ApproachRate: "float",
          SliderMultiplier: "double",
          SliderTickRate: "double",
        },
      },
      {
        name: "BeatmapMetadata",
        properties: {
          Title: "string?",
          TitleUnicode: "string?",
          Artist: "string?",
          ArtistUnicode: "string?",
          Author: "RealmUser",
          Source: "string?",
          Tags: "string?",
          UserTags: "string[]",
          PreviewTime: "int",
          AudioFile: "string?",
          BackgroundFile: "string?",
        },
      },
      {
        name: "BeatmapUserSettings",
        embedded: true,
        properties: { Offset: "double" },
      },
      {
        name: "Beatmap",
        primaryKey: "ID",
        properties: {
          ID: "uuid",
          DifficultyName: "string?",
          Ruleset: "Ruleset",
          Difficulty: "BeatmapDifficulty",
          Metadata: "BeatmapMetadata",
          UserSettings: "BeatmapUserSettings",
          BeatmapSet: "BeatmapSet",
          Status: "int",
          OnlineID: { type: "int", indexed: true },
          Length: "double",
          BPM: "double",
          Hash: "string?",
          StarRating: "double",
          MD5Hash: { type: "string", optional: true, indexed: true },
          OnlineMD5Hash: "string?",
          LastLocalUpdate: "date?",
          LastOnlineUpdate: "date?",
          Hidden: "bool",
          EndTimeObjectCount: "int",
          TotalObjectCount: "int",
          LastPlayed: "date?",
          BeatDivisor: "int",
          EditorTimestamp: "double?",
        },
      },
      {
        name: "BeatmapSet",
        primaryKey: "ID",
        properties: {
          ID: "uuid",
          OnlineID: { type: "int", indexed: true },
          DateAdded: "date",
          DateSubmitted: "date?",
          DateRanked: "date?",
          Beatmaps: "Beatmap[]",
          Files: "RealmNamedFileUsage[]",
          Status: "int",
          DeletePending: "bool",
          Hash: "string?",
          Protected: "bool",
        },
      },
      {
        name: "Score",
        primaryKey: "ID",
        properties: {
          ID: "uuid",
          BeatmapHash: "string?",
          BeatmapInfo: "Beatmap",
        },
      },
    ];
    const r = new Realm({ path: ${JSON.stringify(realmPath)}, schema, schemaVersion: 52 });
    r.write(() => {
      r.create("Ruleset", { ShortName: "osu", OnlineID: 0, Name: "osu!", InstantiationInfo: "", LastAppliedDifficultyVersion: 20260706, Available: true });
      r.create("Ruleset", { ShortName: "taiko", OnlineID: 1, Name: "osu!taiko", InstantiationInfo: "", LastAppliedDifficultyVersion: 20260706, Available: true });
      r.create("Ruleset", { ShortName: "fruits", OnlineID: 2, Name: "osu!catch", InstantiationInfo: "", LastAppliedDifficultyVersion: 20260706, Available: true });
      r.create("Ruleset", { ShortName: "mania", OnlineID: 3, Name: "osu!mania", InstantiationInfo: "", LastAppliedDifficultyVersion: 20260706, Available: true });
      const scoreHash = ${JSON.stringify(orphanScoreBeatmapSha256 ?? "")};
      if (scoreHash) {
        r.create("Score", { ID: new UUID(), BeatmapHash: scoreHash, BeatmapInfo: null });
      }
    });
    r.close();
    process.exit(0);
  `;

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["-e", seedScript], { stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Seed Realm script exited with code ${code}`));
    });
  });
}

function inspectRealmSummary(realmPath: string): Promise<{
  schemaVersion: number;
  setCount: number;
  beatmapCount: number;
  attachedScores: number;
}> {
  const realmPkgDir = require.resolve("realm/package.json").replace(/[/\\]package\.json$/, "");
  const checkScript = `
    globalThis.fetch = globalThis.fetch || (() => Promise.reject(new Error("offline")));
    const Realm = require(${JSON.stringify(realmPkgDir)});
    const r = new Realm({ path: ${JSON.stringify(realmPath)} });
    const out = {
      schemaVersion: r.schemaVersion,
      setCount: r.objects("BeatmapSet").length,
      beatmapCount: r.objects("Beatmap").length,
      attachedScores: r.objects("Score").filtered("BeatmapInfo != null").length,
    };
    r.close();
    process.stdout.write("SUMMARY:" + JSON.stringify(out) + "\\n", () => process.exit(0));
  `;
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["-e", checkScript], { stdio: ["ignore", "pipe", "inherit"] });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      const line = stdout.split(/\r?\n/).find((l) => l.startsWith("SUMMARY:"));
      if (code === 0 && line) {
        resolvePromise(JSON.parse(line.slice("SUMMARY:".length)));
      } else {
        rejectPromise(new Error(`Inspect script failed (${code}): ${stdout}`));
      }
    });
  });
}

describe("Beatmap downloader & offline importers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "rewind-beatmap-dl-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("parseOszArchive", () => {
    it("parses difficulties, colons in metadata, BPM/length, and strips common folder prefixes", () => {
      const osz = buildSampleOszBuffer("111000 Camellia - Re_TrymenT/");
      const parsed = parseOszArchive(osz);

      expect(parsed.files).toHaveLength(5);
      expect(parsed.difficulties).toHaveLength(2);

      const insane = parsed.difficulties.find((d) => d.difficultyName === "Insane");
      expect(insane).toBeDefined();
      expect(insane?.title).toBe("Re:TrymenT: Story");
      expect(insane?.titleUnicode).toBe("Re:TrymenT: ストーリー");
      expect(insane?.artist).toBe("Camellia");
      expect(insane?.creator).toBe("TestMapper");
      expect(insane?.md5Hash).toBe(md5(SAMPLE_OSU_INSANE));
      expect(insane?.sha256Hash).toBe(sha256(SAMPLE_OSU_INSANE));
      expect(insane?.bpm).toBeCloseTo(200, 3);
      expect(insane?.lengthMs).toBe(4500);
      expect(insane?.totalObjectCount).toBe(3);
      expect(insane?.endTimeObjectCount).toBe(2); // 1 slider + 1 spinner

      const hard = parsed.difficulties.find((d) => d.difficultyName === "Hard");
      expect(hard?.approachRate).toBe(7); // Defaults to OverallDifficulty when ApproachRate is omitted
    });

    it("rejects non-ZIP HTML responses and Zip-Slip path traversal entries", () => {
      expect(() => parseOszArchive(Buffer.from("<html>429 Too Many Requests</html>"))).toThrow(
        /not a valid \.osz ZIP archive/,
      );

      const maliciousZip = new AdmZip();
      maliciousZip.addFile("SAFE__evil.osu", Buffer.from(SAMPLE_OSU_HARD));
      const rawZipBuf = Buffer.from(
        maliciousZip.toBuffer().toString("latin1").split("SAFE__evil.osu").join("../../evil.osu"),
        "latin1",
      );
      expect(() => parseOszArchive(rawZipBuf)).toThrow(/Unsafe file path/);
    });
  });

  describe("importOszToFolder (osu!stable)", () => {
    it("sanitizes folder names and extracts all beatmap files", async () => {
      expect(sanitizeBeatmapFolderName('111000 Camellia: "Re:TrymenT"?* ')).toBe("111000 Camellia_ _Re_TrymenT___");

      const songsDir = join(tempDir, "Songs");
      const archive = parseOszArchive(buildSampleOszBuffer());
      const folderName = await importOszToFolder(archive, songsDir, 111000);

      expect(folderName).toBe("111000 Camellia - Re_TrymenT_ Story");
      const audioStat = await stat(join(songsDir, folderName, "audio.mp3"));
      expect(audioStat.isFile()).toBe(true);
      const sbStat = await stat(join(songsDir, folderName, "sb", "glow.png"));
      expect(sbStat.isFile()).toBe(true);
    });
  });

  describe("importOszToLazerOffline (offline client.realm)", () => {
    it("imports into offline client.realm + files/, preserves schemaVersion, reattaches scores, and reads back cleanly via LazerDBReader", async () => {
      const lazerDir = join(tempDir, "lazer");
      await importOszToFolder(parseOszArchive(buildSampleOszBuffer()), join(tempDir, "dummy")); // ensure tempDir exists
      const { mkdir } = await import("fs/promises");
      await mkdir(join(lazerDir, "files"), { recursive: true });

      const realmPath = join(lazerDir, "client.realm");
      const insaneSha256 = sha256(SAMPLE_OSU_INSANE);
      const insaneMd5 = md5(SAMPLE_OSU_INSANE);
      await createSeedLazerRealm(realmPath, insaneSha256);

      const archive = parseOszArchive(buildSampleOszBuffer());
      await importOszToLazerOffline(archive, lazerDir, {
        targetMd5: insaneMd5,
        onlineMetadata: {
          md5: insaneMd5,
          beatmapId: 222001,
          beatmapSetId: 111000,
          title: "Re:TrymenT: Story",
          artist: "Camellia",
          creator: "TestMapper",
          difficultyName: "Insane",
          status: 1,
        },
      });

      // Verify backup file was created
      const backupStat = await stat(join(lazerDir, "client.realm.rewind.bak"));
      expect(backupStat.isFile()).toBe(true);

      // Verify hashed blob exists in files/<h>/<hh>/<sha256>
      const audioSha = sha256(Buffer.from("FAKE_MP3_CONTENT"));
      const audioBlob = await readFile(join(lazerDir, lazerFilePath(audioSha)));
      expect(audioBlob.toString()).toBe("FAKE_MP3_CONTENT");

      // Verify Rewind's pure-TypeScript binary LazerDBReader reads the imported beatmaps cleanly
      const realmBuffer = await readFile(realmPath);
      const beatmaps = new LazerDBReader(realmBuffer).readBeatmaps();
      expect(beatmaps).toHaveLength(2);

      const importedInsane = beatmaps.find((b) => b.md5Hash === insaneMd5);
      expect(importedInsane).toBeDefined();
      expect(importedInsane?.title).toBe("Re:TrymenT: Story");
      expect(importedInsane?.artist).toBe("Camellia");
      expect(importedInsane?.creator).toBe("TestMapper");
      expect(importedInsane?.difficultyName).toBe("Insane");
      expect(importedInsane?.audioFileName).toBe("audio.mp3");
      expect(importedInsane?.backgroundFileName).toBe("bg.jpg");
      expect(importedInsane?.rulesetId).toBe(0);
      expect(importedInsane?.files).toHaveLength(5);

      // Verify schemaVersion remained 52 and orphan score was reattached
      const summaryAfterFirst = await inspectRealmSummary(realmPath);
      expect(summaryAfterFirst).toEqual({
        schemaVersion: 52,
        setCount: 1,
        beatmapCount: 2,
        attachedScores: 1,
      });

      // Re-importing the identical archive should be idempotent (reuse existing BeatmapSet)
      await importOszToLazerOffline(archive, lazerDir, { targetMd5: insaneMd5 });
      const summaryAfterSecond = await inspectRealmSummary(realmPath);
      expect(summaryAfterSecond).toEqual({
        schemaVersion: 52,
        setCount: 1,
        beatmapCount: 2,
        attachedScores: 1,
      });
    }, 30_000);
  });

  describe("BeatmapDownloadService end-to-end mirror failover", () => {
    it("falls back across mirrors on failure, verifies target MD5, and imports offline into lazer", async () => {
      const lazerDir = join(tempDir, "lazer-e2e");
      const { mkdir } = await import("fs/promises");
      await mkdir(join(lazerDir, "files"), { recursive: true });
      await createSeedLazerRealm(join(lazerDir, "client.realm"));

      const insaneMd5 = md5(SAMPLE_OSU_INSANE);
      const oszBuffer = buildSampleOszBuffer();

      const requestedUrls: string[] = [];
      const mockFetcher = async (url: string): Promise<HttpResponseBuffer> => {
        requestedUrls.push(url);
        if (url.includes("catboy.best/api/v2/md5/")) {
          return { statusCode: 503, headers: {}, body: Buffer.from("unavailable") };
        }
        if (url.includes("osu.direct/api/v2/md5/")) {
          return {
            statusCode: 200,
            headers: { "content-type": "application/json" },
            body: Buffer.from(
              JSON.stringify({
                id: 222001,
                beatmapset_id: 111000,
                version: "Insane",
                status: "ranked",
                beatmapset: {
                  id: 111000,
                  title: "Re:TrymenT: Story",
                  artist: "Camellia",
                  creator: "TestMapper",
                },
              }),
            ),
          };
        }
        if (url.includes("catboy.best/d/")) {
          return { statusCode: 429, headers: {}, body: Buffer.from("rate limited") };
        }
        if (url.includes("api.nerinyan.moe/d/")) {
          return {
            statusCode: 200,
            headers: { "content-length": String(oszBuffer.length) },
            body: oszBuffer,
          };
        }
        return { statusCode: 404, headers: {}, body: Buffer.alloc(0) };
      };

      const progressEvents: BeatmapDownloadProgressEvent[] = [];
      const mirrorClient = new BeatmapMirrorClient("Rewind/0.3.0-test", mockFetcher);
      const service = new BeatmapDownloadService({
        userDataPath: join(tempDir, "userData"),
        mirrorClient,
        emitProgress: (ev) => progressEvents.push(ev),
      });

      const result = await service.downloadAndImport({
        md5: insaneMd5,
        replayClient: "lazer",
        preferredTarget: "auto",
        preferredMirror: "catboy",
        noVideo: true,
        lazerFolder: lazerDir,
      });

      expect(result.importedTo).toBe("lazer");
      expect(result.metadata.beatmapSetId).toBe(111000);
      expect(requestedUrls).toEqual([
        `https://catboy.best/api/v2/md5/${insaneMd5}`,
        `https://osu.direct/api/v2/md5/${insaneMd5}`,
        "https://catboy.best/d/111000n",
        "https://api.nerinyan.moe/d/111000?noVideo=1",
      ]);
      expect(progressEvents.map((e) => e.stage)).toContain("resolving");
      expect(progressEvents.map((e) => e.stage)).toContain("downloading");
      expect(progressEvents.map((e) => e.stage)).toContain("importing");

      const realmBeatmaps = new LazerDBReader(await readFile(join(lazerDir, "client.realm"))).readBeatmaps();
      expect(realmBeatmaps.some((b) => b.md5Hash === insaneMd5)).toBe(true);
    }, 30_000);
  });
});
