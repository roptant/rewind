// Type definitions for the parts of the `lzma` package (pure JavaScript LZMA, also used by node-osr) that are used
declare module "lzma" {
  // Returns a string if the decompressed data is valid UTF-8, otherwise the bytes
  export function decompress(data: number[] | Uint8Array): string | number[];
}
