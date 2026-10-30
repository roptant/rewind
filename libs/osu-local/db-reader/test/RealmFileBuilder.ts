import { RealmColumnType } from "../src/RealmReader";

// Builds (small) Realm files for testing purposes, following the same layout as realm-core. See `RealmReader.ts`.

export type RealmTestValue = number | boolean | string | Date | null | number[];

export interface ColumnDefinition {
  name: string;
  type: number;
  nullable?: boolean;
  list?: boolean;
  // Name of the table that the link column is pointing to
  target?: string;
  // How the strings of the column are stored (realm-core picks it based on the length of the strings)
  strings?: "short" | "medium" | "big";
}

export interface TableDefinition {
  name: string;
  columns: ColumnDefinition[];
  // Links are given as the indices of the rows in the target table
  rows: Record<string, RealmTestValue>[];
  // Splits the rows into multiple clusters that are referenced by an inner node
  clusterSizes?: number[];
}

export interface BuildOptions {
  streamingForm?: boolean;
  fileFormatVersion?: number;
}

const INNER_BPTREE_NODE = 0x80;
const HAS_REFS = 0x40;
const CONTEXT_FLAG = 0x20;
const WTYPE_MULTIPLY = 1 << 3;
const WTYPE_IGNORE = 2 << 3;

const ATTRIBUTE_NULLABLE = 16;
const ATTRIBUTE_LIST = 32;

const STREAMING_FOOTER_MAGIC_COOKIE = BigInt("0x3034125237E526C8");

const tagged = (value: number) => value * 2 + 1;

function bitWidth(values: number[]): number {
  if (values.every((v) => v === 0)) return 0;
  if (values.every((v) => v >= 0 && v <= 1)) return 1;
  if (values.every((v) => v >= 0 && v <= 3)) return 2;
  if (values.every((v) => v >= 0 && v <= 15)) return 4;
  for (const width of [8, 16, 32]) {
    const limit = Math.pow(2, width - 1);
    if (values.every((v) => v >= -limit && v < limit)) return width;
  }
  return 64;
}

// The width is stored as the index in [0, 1, 2, 4, 8, 16, 32, 64]
const widthIndex = (width: number) => (width === 0 ? 0 : Math.log2(width) + 1);

class NodeWriter {
  private readonly chunks: Buffer[] = [];
  private size = 24; // Room for the file header

  write(flags: number, size: number, payload: Buffer): number {
    const ref = this.size;
    const node = Buffer.alloc(8 + Math.ceil(payload.length / 8) * 8);
    node.write("AAAA", 0, "latin1");
    node[4] = flags;
    node.writeUIntBE(size, 5, 3);
    payload.copy(node, 8);
    this.chunks.push(node);
    this.size += node.length;
    return ref;
  }

  ints(values: number[], flags = 0): number {
    const width = bitWidth(values);
    const payload = Buffer.alloc(Math.ceil((values.length * width) / 8));
    values.forEach((v, i) => {
      if (width > 0 && width < 8) {
        payload[(i * width) >> 3] |= v << ((i * width) & 7);
      } else if (width === 8) {
        payload.writeInt8(v, i);
      } else if (width === 16) {
        payload.writeInt16LE(v, i * 2);
      } else if (width === 32) {
        payload.writeInt32LE(v, i * 4);
      } else if (width === 64) {
        payload.writeBigInt64LE(BigInt(v), i * 8);
      }
    });
    return this.write(flags | widthIndex(width), values.length, payload);
  }

  refs(refs: number[], flags = 0): number {
    return this.ints(refs, flags | HAS_REFS);
  }

  blob(data: Buffer): number {
    return this.write(WTYPE_IGNORE | widthIndex(1), data.length, data);
  }

  // ArrayStringShort
  shortStrings(values: (string | null)[]): number {
    const encoded = values.map((v) => (v === null ? null : Buffer.from(v, "utf-8")));
    const maxLength = Math.max(0, ...encoded.map((b) => (b ? b.length : 0)));
    const width = [4, 8, 16, 32, 64].find((w) => w > maxLength) ?? 64;
    const payload = Buffer.alloc(values.length * width);
    encoded.forEach((bytes, i) => {
      const start = i * width;
      if (bytes) bytes.copy(payload, start);
      payload[start + width - 1] = bytes ? width - 1 - bytes.length : width;
    });
    return this.write(WTYPE_MULTIPLY | widthIndex(width), values.length, payload);
  }

  // ArraySmallBlobs: [offsets, blob, nulls]
  mediumStrings(values: (string | null)[]): number {
    const offsets: number[] = [];
    const parts: Buffer[] = [];
    let offset = 0;
    for (const v of values) {
      if (v !== null) {
        const bytes = Buffer.concat([Buffer.from(v, "utf-8"), Buffer.alloc(1)]);
        parts.push(bytes);
        offset += bytes.length;
      }
      offsets.push(offset);
    }
    const nulls = values.map((v) => (v === null ? 1 : 0));
    return this.refs([this.ints(offsets), this.blob(Buffer.concat(parts)), this.ints(nulls)]);
  }

  // ArrayBigBlobs: every string has its own blob
  bigStrings(values: (string | null)[]): number {
    const refs = values.map((v) =>
      v === null ? 0 : this.blob(Buffer.concat([Buffer.from(v, "utf-8"), Buffer.alloc(1)])),
    );
    return this.refs(refs, CONTEXT_FLAG);
  }

  // ArrayIntNull: the first element is the value that represents null
  nullableInts(values: (number | null)[]): number {
    const nullValue = Math.max(0, ...values.map((v) => v ?? 0)) + 1;
    return this.ints([nullValue, ...values.map((v) => v ?? nullValue)]);
  }

  // ArrayFixedBytes: blocks of a null bit vector followed by 8 values
  uuids(values: (string | null)[]): number {
    const payload = Buffer.alloc(values.length * 16 + Math.ceil(values.length / 8));
    values.forEach((v, i) => {
      const block = Math.floor(i / 8) * (16 * 8 + 1);
      if (v === null) {
        payload[block] |= 1 << i % 8;
      } else {
        Buffer.from(v.replace(/-/g, ""), "hex").copy(payload, block + 1 + (i % 8) * 16);
      }
    });
    return this.write(WTYPE_IGNORE | widthIndex(1), payload.length, payload);
  }

  // ArrayTimestamp: [seconds, nanoseconds]
  timestamps(values: (Date | null)[]): number {
    const seconds = values.map((v) => (v === null ? null : Math.floor(v.getTime() / 1000)));
    const nanoseconds = values.map((v) => (v === null ? 0 : (v.getTime() % 1000) * 1e6));
    return this.refs([this.nullableInts(seconds), this.ints(nanoseconds)]);
  }

  // B+tree with the given leaves, an inner node is created if there are multiple leaves
  bpTree(leaves: number[][]): number {
    const leafRefs = leaves.map((keys) => this.ints(keys));
    if (leafRefs.length === 1) return leafRefs[0];
    const total = leaves.reduce((sum, l) => sum + l.length, 0);
    return this.refs([tagged(leaves[0].length), ...leafRefs, tagged(total)], INNER_BPTREE_NODE);
  }

  finish(topRef: number, { streamingForm = false, fileFormatVersion = 24 }: BuildOptions): Buffer {
    const header = Buffer.alloc(24);
    if (streamingForm) {
      header.writeBigUInt64LE(BigInt("0xFFFFFFFFFFFFFFFF"), 0);
    } else {
      // Uses the second slot to make sure the select bit is respected
      header.writeBigUInt64LE(BigInt(8), 0);
      header.writeBigUInt64LE(BigInt(topRef), 8);
    }
    header.write("T-DB", 16, "latin1");
    header[20] = fileFormatVersion;
    header[21] = fileFormatVersion;
    header[23] = streamingForm ? 0 : 1;
    const parts = [header, ...this.chunks];
    if (streamingForm) {
      const footer = Buffer.alloc(16);
      footer.writeBigUInt64LE(BigInt(topRef), 0);
      footer.writeBigUInt64LE(STREAMING_FOOTER_MAGIC_COOKIE, 8);
      parts.push(footer);
    }
    return Buffer.concat(parts);
  }
}

// The keys of the objects: the first cluster uses compact keys (0, 1, 2, ...), the other ones explicit keys
function objectKeys(table: TableDefinition): number[] {
  const sizes = table.clusterSizes ?? [table.rows.length];
  return sizes.flatMap((size, cluster) =>
    Array.from({ length: size }, (_, i) => cluster * 256 + (cluster === 0 ? i : i * 2 + 1)),
  );
}

export function buildRealmFile(tables: TableDefinition[], options: BuildOptions = {}): Buffer {
  const writer = new NodeWriter();
  const tableIndex = (name: string) => tables.findIndex((t) => t.name === name);
  // The upper bits of a table key are a tag, only the lower 16 bits are the index
  const tableKey = (name: string) => (7 << 16) + tableIndex(name);
  const keys = tables.map(objectKeys);
  const keyOf = (target: string, row: number) => keys[tableIndex(target)][row];

  const tableRefs = tables.map((table, t) => {
    // Every table gets an additional (unnamed) backlink column at the end of the spec
    const columnCount = table.columns.length + 1;
    const leafIndex = (specIndex: number) => (specIndex + 1) % columnCount;

    const types = [...table.columns.map((c) => c.type), RealmColumnType.BackLink];
    const attributes = [
      ...table.columns.map((c) => (c.nullable ? ATTRIBUTE_NULLABLE : 0) | (c.list ? ATTRIBUTE_LIST : 0)),
      0,
    ];
    const columnKeys = types.map((type, i) => leafIndex(i) + type * 0x10000 + attributes[i] * 0x400000 + 0x40000000);
    const spec = writer.refs([
      writer.ints(types),
      writer.shortStrings(table.columns.map((c) => c.name)),
      writer.ints(attributes),
      0,
      0,
      writer.ints(columnKeys),
    ]);

    const oppositeTables = new Array(columnCount).fill(0);
    table.columns.forEach((c, i) => {
      if (c.target) oppositeTables[leafIndex(i)] = tableKey(c.target);
    });

    const writeColumn = (column: ColumnDefinition, rows: Record<string, RealmTestValue>[]): number => {
      const values = rows.map((r) => r[column.name] ?? null);
      if (column.list) {
        return writer.refs(
          values.map((v) => {
            const list = (v as number[]).map((row) => (column.target ? keyOf(column.target, row) : row));
            if (list.length === 0) return 0;
            // Longer lists are split into two leaves
            return list.length >= 4 ? writer.bpTree([list.slice(0, 2), list.slice(2)]) : writer.bpTree([list]);
          }),
        );
      }
      switch (column.type) {
        case RealmColumnType.Int:
          return column.nullable ? writer.nullableInts(values as (number | null)[]) : writer.ints(values as number[]);
        case RealmColumnType.Bool:
          return writer.ints(values.map((v) => (v === null ? 3 : v ? 1 : 0)));
        case RealmColumnType.String: {
          const strings = values as (string | null)[];
          if (column.strings === "medium") return writer.mediumStrings(strings);
          if (column.strings === "big") return writer.bigStrings(strings);
          return writer.shortStrings(strings);
        }
        case RealmColumnType.Link:
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          return writer.ints(values.map((v) => (v === null ? 0 : keyOf(column.target!, v as number) + 1)));
        case RealmColumnType.Timestamp:
          return writer.timestamps(values as (Date | null)[]);
        case RealmColumnType.UUID:
          return writer.uuids(values as (string | null)[]);
      }
      throw new Error(`Column type ${column.type} is not supported by the builder`);
    };

    const sizes = table.clusterSizes ?? [table.rows.length];
    let firstRow = 0;
    const clusters = sizes.map((size, cluster) => {
      const rows = table.rows.slice(firstRow, firstRow + size);
      const clusterKeys = keys[t].slice(firstRow, firstRow + size).map((k) => k - cluster * 256);
      firstRow += size;
      const leaves = new Array(columnCount).fill(0);
      table.columns.forEach((c, i) => (leaves[leafIndex(i)] = writeColumn(c, rows)));
      leaves[leafIndex(columnCount - 1)] = writer.ints(rows.map(() => 0));
      return writer.refs([cluster === 0 ? tagged(size) : writer.ints(clusterKeys), ...leaves]);
    });
    const clusterRoot =
      clusters.length === 1
        ? clusters[0]
        : writer.refs([0, tagged(1), tagged(table.rows.length), ...clusters], INNER_BPTREE_NODE);

    return writer.refs([spec, 0, clusterRoot, tagged(tableKey(table.name)), 0, 0, 0, writer.ints(oppositeTables), 0]);
  });

  const top = writer.refs([writer.shortStrings(tables.map((t) => t.name)), writer.refs(tableRefs), tagged(0)]);
  return writer.finish(top, options);
}
