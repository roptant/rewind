import { RealmColumnType } from "./RealmReader";
import { findLazerFile, LazerDBReader, lazerFilePath } from "./LazerDBReader";
import { buildRealmFile, TableDefinition } from "../test/RealmFileBuilder";

const { String, Int, Bool, Link, Timestamp, UUID } = RealmColumnType;

// A tiny osu!lazer database with the parts of the schema that are relevant
const tables: TableDefinition[] = [
  {
    name: "class_File",
    columns: [{ name: "Hash", type: String, nullable: true }],
    rows: [
      { Hash: "a1556d08" },
      { Hash: "47b89548" },
      { Hash: "b6e1f7c2" },
      { Hash: "c0ffee00" },
      { Hash: "deadbeef" },
    ],
  },
  {
    name: "class_RealmNamedFileUsage",
    columns: [
      { name: "File", type: Link, nullable: true, target: "class_File" },
      { name: "Filename", type: String, nullable: true, strings: "medium" },
    ],
    rows: [
      { File: 0, Filename: "cYsmix - triangles (peppy) [peppy].osu" },
      { File: 1, Filename: "audio.mp3" },
      { File: 2, Filename: "bg/Triangles.JPG" },
      { File: 3, Filename: "skin.ini" },
      { File: 4, Filename: "hitcircle@2x.png" },
      { File: 0, Filename: "deleted.osu" },
    ],
  },
  {
    name: "class_RealmUser",
    columns: [{ name: "Username", type: String, nullable: true }],
    rows: [{ Username: "peppy" }],
  },
  {
    name: "class_Ruleset",
    columns: [{ name: "OnlineID", type: Int }],
    rows: [{ OnlineID: 0 }, { OnlineID: 3 }],
  },
  {
    name: "class_BeatmapMetadata",
    columns: [
      { name: "Title", type: String, nullable: true },
      { name: "TitleUnicode", type: String, nullable: true },
      { name: "Artist", type: String, nullable: true },
      { name: "ArtistUnicode", type: String, nullable: true },
      { name: "Author", type: Link, nullable: true, target: "class_RealmUser" },
      { name: "AudioFile", type: String, nullable: true },
      { name: "BackgroundFile", type: String, nullable: true },
    ],
    rows: [
      {
        Title: "triangles",
        TitleUnicode: "triangles",
        Artist: "cYsmix",
        ArtistUnicode: "cYsmix",
        Author: 0,
        AudioFile: "audio.mp3",
        BackgroundFile: "bg\\triangles.jpg",
      },
    ],
  },
  {
    name: "class_BeatmapSet",
    columns: [
      { name: "Files", type: Link, list: true, target: "class_RealmNamedFileUsage" },
      { name: "DeletePending", type: Bool },
    ],
    rows: [
      { Files: [0, 1, 2], DeletePending: false },
      { Files: [5], DeletePending: true },
    ],
  },
  {
    name: "class_Beatmap",
    columns: [
      { name: "DifficultyName", type: String, nullable: true },
      { name: "Ruleset", type: Link, nullable: true, target: "class_Ruleset" },
      { name: "Metadata", type: Link, nullable: true, target: "class_BeatmapMetadata" },
      { name: "BeatmapSet", type: Link, nullable: true, target: "class_BeatmapSet" },
      { name: "Hash", type: String, nullable: true },
      { name: "MD5Hash", type: String, nullable: true },
      { name: "LastPlayed", type: Timestamp, nullable: true },
    ],
    rows: [
      {
        DifficultyName: "peppy",
        Ruleset: 0,
        Metadata: 0,
        BeatmapSet: 0,
        Hash: "a1556d08",
        MD5Hash: "27d97656",
        LastPlayed: new Date("2026-10-30T03:39:47.000Z"),
      },
      {
        DifficultyName: "deleted",
        Ruleset: 1,
        Metadata: 0,
        BeatmapSet: 1,
        Hash: "a1556d08",
        MD5Hash: "11111111",
        LastPlayed: null,
      },
    ],
  },
  {
    name: "class_Skin",
    columns: [
      { name: "ID", type: UUID },
      { name: "Name", type: String, nullable: true },
      { name: "Creator", type: String, nullable: true },
      { name: "Protected", type: Bool },
      { name: "Files", type: Link, list: true, target: "class_RealmNamedFileUsage" },
      { name: "DeletePending", type: Bool },
    ],
    rows: [
      {
        ID: "cffa69de-b3e3-4dee-8563-3c4f425c05d0",
        Name: 'osu! "argon" (2022)',
        Creator: "team osu!",
        Protected: true,
        Files: [],
        DeletePending: false,
      },
      {
        ID: "5c11ff05-aae8-4fcf-b188-c526d39da103",
        Name: "Vaxei: 2023",
        Creator: "Hi :>",
        Protected: false,
        Files: [3, 4],
        DeletePending: false,
      },
      {
        ID: "3e1b4042-e2f5-4373-bf77-cb846113dc64",
        Name: "Deleted",
        Creator: "",
        Protected: false,
        Files: [4],
        DeletePending: true,
      },
    ],
  },
];

describe("LazerDBReader", () => {
  const reader = new LazerDBReader(buildRealmFile(tables));

  it("reads the beatmaps that are not deleted", () => {
    expect(reader.readBeatmaps()).toEqual([
      {
        md5Hash: "27d97656",
        hash: "a1556d08",
        osuFileName: "cYsmix - triangles (peppy) [peppy].osu",
        difficultyName: "peppy",
        artist: "cYsmix",
        artistUnicode: "cYsmix",
        title: "triangles",
        titleUnicode: "triangles",
        creator: "peppy",
        audioFileName: "audio.mp3",
        backgroundFileName: "bg\\triangles.jpg",
        rulesetId: 0,
        lastPlayed: new Date("2026-10-30T03:39:47.000Z"),
        files: [
          { filename: "cYsmix - triangles (peppy) [peppy].osu", hash: "a1556d08" },
          { filename: "audio.mp3", hash: "47b89548" },
          { filename: "bg/Triangles.JPG", hash: "b6e1f7c2" },
        ],
      },
    ]);
  });

  it("reads the skins that are not deleted", () => {
    expect(reader.readSkins()).toEqual([
      {
        id: "cffa69de-b3e3-4dee-8563-3c4f425c05d0",
        name: 'osu! "argon" (2022)',
        creator: "team osu!",
        isProtected: true,
        files: [],
      },
      {
        id: "5c11ff05-aae8-4fcf-b188-c526d39da103",
        name: "Vaxei: 2023",
        creator: "Hi :>",
        isProtected: false,
        files: [
          { filename: "skin.ini", hash: "c0ffee00" },
          { filename: "hitcircle@2x.png", hash: "deadbeef" },
        ],
      },
    ]);
  });

  it("finds the files like osu!lazer does (case-insensitive and with any slashes)", () => {
    const { files } = reader.readBeatmaps()[0];
    expect(findLazerFile(files, "bg\\triangles.jpg")?.hash).toEqual("b6e1f7c2");
    expect(findLazerFile(files, "AUDIO.mp3")?.hash).toEqual("47b89548");
    expect(findLazerFile(files, "")).toBeUndefined();
    expect(findLazerFile(files, "video.mp4")).toBeUndefined();
  });

  it("returns the path of the files in the data folder", () => {
    expect(lazerFilePath("a1556d0801b3")).toEqual("files/a/a1/a1556d0801b3");
  });
});
