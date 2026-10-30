import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { determineLazerDataFolder } from "./lazer";

describe("determineLazerDataFolder", () => {
  let folder: string;

  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), "rewind-lazer-"));
  });

  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  test("uses the custom storage location from storage.ini", async () => {
    await writeFile(join(folder, "storage.ini"), "FullPath = P:\\Gaming\\osu-lazer\r\n");
    expect(await determineLazerDataFolder(folder)).toEqual("P:\\Gaming\\osu-lazer");
  });

  test("uses the given folder if there is no custom storage location", async () => {
    expect(await determineLazerDataFolder(folder)).toEqual(folder);
  });
});
