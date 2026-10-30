import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SkinFolderReader } from "./SkinFolderReader";

describe("SkinFolderReader.getMappedSkinResolver", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "rewind-skin-"));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  // This is how osu!lazer stores the skins: the files are named after their hashes
  test("resolves the textures of skins whose files are stored with different names", async () => {
    await writeFile(
      join(folder, "c0ffee00"),
      "[General]\r\nName: Hashed\r\n\r\n[Fonts]\r\nComboPrefix: Assets\\combo\r\n",
    );
    const resolver = await SkinFolderReader.getMappedSkinResolver([
      { fileName: "skin.ini", path: join(folder, "c0ffee00") },
      { fileName: "HitCircle@2x.png", path: "/files/d/de/deadbeef" },
      { fileName: "hitcircleoverlay.png", path: "/files/a/ab/abcdef" },
      { fileName: "Assets/combo-0.png", path: "/files/1/12/123456" },
    ]);

    expect(resolver.config.general.name).toEqual("Hashed");
    expect(await resolver.resolve("HIT_CIRCLE", { hdIfExists: true })).toEqual(["hitcircle@2x.png"]);
    expect(await resolver.resolve("HIT_CIRCLE_OVERLAY", { hdIfExists: true })).toEqual(["hitcircleoverlay.png"]);
    expect(await resolver.resolve("COMBO_0", { hdIfExists: true })).toEqual(["Assets\\combo-0.png"]);
    expect(await resolver.resolve("APPROACH_CIRCLE", { hdIfExists: true })).toEqual([]);

    expect(resolver.getFilePath("hitcircle@2x.png")).toEqual("/files/d/de/deadbeef");
    expect(resolver.getFilePath("Assets\\combo-0.png")).toEqual("/files/1/12/123456");
  });

  test("uses the default config if there is no skin.ini", async () => {
    const resolver = await SkinFolderReader.getMappedSkinResolver([]);
    expect(resolver.config.fonts.comboPrefix).toEqual("score");
  });
});
