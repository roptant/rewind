import { modsFromBitmask, modsToBitmask } from "./RawReplayData";

describe("Replay mods bitmask", function () {
  it("converts the mods to the legacy bitmask", function () {
    expect(modsToBitmask([])).toBe(0);
    expect(modsToBitmask(["HIDDEN", "DOUBLE_TIME"])).toBe(8 + 64);
    expect(modsToBitmask(["HARD_ROCK"])).toBe(16);
    // Nightcore always comes with Double Time
    expect(modsToBitmask(["DOUBLE_TIME", "NIGHT_CORE"])).toBe(64 + 512);
  });

  it("is the inverse of modsFromBitmask", function () {
    const bitmask = 1 + 8 + 16 + 64 + 1024;
    expect(modsToBitmask(modsFromBitmask(bitmask))).toBe(bitmask);
  });
});
