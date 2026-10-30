/**
 * A minimal read-only reader for Realm database files, which is the format osu!lazer uses for its `client.realm`.
 *
 * Only the parts that are needed to read plain object tables are implemented (no writing, no history, no sync). We do
 * not use the official `realm` package since it is a native module, it would have to be ABI-compatible with the
 * Electron version and it can't open a file that is currently opened by osu!lazer with a different Realm version.
 *
 * The file format is not officially documented, so everything here is based on the source code of realm-core:
 * https://github.com/realm/realm-core/tree/master/src/realm (node_header.hpp, alloc_slab.hpp, group.hpp, table.hpp,
 * spec.hpp, cluster.hpp, cluster_tree.cpp, bplustree.cpp, array_string*.hpp, array_blobs_*.hpp, ...)
 */

// The file format versions that use the same layout (Realm Core v10 - v14+) for everything we read.
const MIN_SUPPORTED_FILE_FORMAT = 20;
const MAX_SUPPORTED_FILE_FORMAT = 24;

const STREAMING_FOOTER_MAGIC_COOKIE = BigInt("0x3034125237E526C8");
const STREAMING_FORM_TOP_REF = BigInt("0xFFFFFFFFFFFFFFFF");

const NODE_HEADER_SIZE = 8;

// Indices of the arrays in the respective "top" arrays
const GROUP_TABLE_NAMES_INDEX = 0;
const GROUP_TABLES_INDEX = 1;

const TABLE_SPEC_INDEX = 0;
const TABLE_CLUSTER_TREE_INDEX = 2;
const TABLE_OPPOSITE_TABLE_INDEX = 7;

const SPEC_TYPES_INDEX = 0;
const SPEC_NAMES_INDEX = 1;
const SPEC_ATTRIBUTES_INDEX = 2;
const SPEC_ENUM_KEYS_INDEX = 4;
const SPEC_COLUMN_KEYS_INDEX = 5;

const CLUSTER_KEYS_INDEX = 0;
const CLUSTER_FIRST_COLUMN_INDEX = 1;

const CLUSTER_INNER_KEYS_INDEX = 0;
const CLUSTER_INNER_SUB_TREE_DEPTH_INDEX = 1;
const CLUSTER_INNER_FIRST_CHILD_INDEX = 3;
const CLUSTER_NODE_SHIFT_FACTOR = 8;

const BOOL_NULL_VALUE = 3;

// 1 byte null bit vector followed by 8 UUIDs
const UUID_SIZE = 16;
const UUID_BLOCK_SIZE = UUID_SIZE * 8 + 1;

export const RealmColumnType = {
  Int: 0,
  Bool: 1,
  String: 2,
  Binary: 4,
  Mixed: 6,
  Timestamp: 8,
  Float: 9,
  Double: 10,
  Decimal: 11,
  Link: 12,
  BackLink: 14,
  ObjectId: 15,
  TypedLink: 16,
  UUID: 17,
} as const;

const ColumnAttribute = {
  Nullable: 16,
  List: 32,
  Dictionary: 64,
  Set: 128,
} as const;

// Width types of a node (see `NodeHeader::WidthType`)
const WidthType = {
  Bits: 0, // `width` is the number of bits per element
  Multiply: 1, // `width` is the number of bytes per element
  Ignore: 2, // every element is one byte (blobs)
} as const;

export type RealmValue = number | boolean | string | Date | null | RealmValue[];

export interface RealmColumn {
  name: string;
  type: number;
  nullable: boolean;
  list: boolean;
  // Position of the column data inside a cluster (`ColKey::get_index()`)
  leafIndex: number;
  // Only relevant for enumerated string columns
  enumKeysRef: number;
  // Only relevant for link columns, the name of the table the links are pointing to
  targetTable?: string;
}

export interface RealmObject {
  // The object key (`ObjKey`), which is what links are referring to
  key: number;
  [column: string]: RealmValue;
}

/**
 * Accessor for a single node (array) in the Realm file. Every node starts with an 8 byte header followed by the payload.
 */
class RealmNode {
  readonly isInnerBPTreeNode: boolean;
  readonly hasRefs: boolean;
  readonly contextFlag: boolean;
  readonly widthType: number;
  readonly width: number;
  readonly size: number;
  readonly data: number;

  constructor(private readonly buffer: Buffer, readonly ref: number) {
    if (ref <= 0 || ref % 8 !== 0 || ref + NODE_HEADER_SIZE > buffer.length) {
      throw new Error(`Invalid node reference ${ref} in Realm file`);
    }
    const flags = buffer[ref + 4];
    this.isInnerBPTreeNode = (flags & 0x80) !== 0;
    this.hasRefs = (flags & 0x40) !== 0;
    this.contextFlag = (flags & 0x20) !== 0;
    this.widthType = (flags & 0x18) >> 3;
    this.width = (1 << (flags & 0x07)) >> 1;
    this.size = (buffer[ref + 5] << 16) + (buffer[ref + 6] << 8) + buffer[ref + 7];
    this.data = ref + NODE_HEADER_SIZE;
  }

  // Signed integer for widths >= 8 bits (`Array::get`)
  get(index: number): number {
    return this.read(index, true);
  }

  // Unsigned integer (`ArrayUnsigned::get`), used for the keys of clusters
  getUnsigned(index: number): number {
    return this.read(index, false);
  }

  // Refs are even numbers, odd numbers are "tagged" integers (shifted by one bit)
  getRef(index: number): number {
    const value = this.get(index);
    return value % 2 === 0 ? value : 0;
  }

  getTagged(index: number): number {
    return Math.floor(this.get(index) / 2);
  }

  child(index: number): RealmNode | null {
    const ref = this.getRef(index);
    return ref === 0 ? null : new RealmNode(this.buffer, ref);
  }

  private read(index: number, signed: boolean): number {
    const { buffer, data, width } = this;
    switch (width) {
      case 0:
        return 0;
      case 1:
        return (buffer[data + (index >> 3)] >> (index & 7)) & 0x01;
      case 2:
        return (buffer[data + (index >> 2)] >> ((index & 3) << 1)) & 0x03;
      case 4:
        return (buffer[data + (index >> 1)] >> ((index & 1) << 2)) & 0x0f;
      case 8:
        return signed ? buffer.readInt8(data + index) : buffer.readUInt8(data + index);
      case 16:
        return signed ? buffer.readInt16LE(data + index * 2) : buffer.readUInt16LE(data + index * 2);
      case 32:
        return signed ? buffer.readInt32LE(data + index * 4) : buffer.readUInt32LE(data + index * 4);
      case 64: {
        // Precise up to 2^53 which is more than enough for refs, keys and the integers we are interested in
        const offset = data + index * 8;
        const high = signed ? buffer.readInt32LE(offset + 4) : buffer.readUInt32LE(offset + 4);
        return high * 0x100000000 + buffer.readUInt32LE(offset);
      }
    }
    throw new Error(`Unsupported node width ${width}`);
  }
}

export class RealmReader {
  readonly fileFormatVersion: number;
  private readonly tableIndexByName = new Map<string, number>();
  private readonly tableNames: string[] = [];
  private readonly tables: RealmNode;

  constructor(private readonly buffer: Buffer) {
    if (buffer.length < 24 || buffer.toString("latin1", 16, 20) !== "T-DB") {
      throw new Error("Not a Realm file (invalid mnemonic)");
    }
    const flags = buffer[23];
    const slot = flags & 1;
    this.fileFormatVersion = buffer[20 + slot];
    if (this.fileFormatVersion < MIN_SUPPORTED_FILE_FORMAT || this.fileFormatVersion > MAX_SUPPORTED_FILE_FORMAT) {
      throw new Error(`Unsupported Realm file format version ${this.fileFormatVersion}`);
    }

    let topRef = buffer.readBigUInt64LE(slot * 8);
    if (slot === 0 && topRef === STREAMING_FORM_TOP_REF) {
      // Files that were written by `Realm.writeCopy` or compacting have their top ref at the end of the file
      const footer = buffer.length - 16;
      if (buffer.readBigUInt64LE(footer + 8) !== STREAMING_FOOTER_MAGIC_COOKIE) {
        throw new Error("Realm file is in streaming form but has an invalid footer");
      }
      topRef = buffer.readBigUInt64LE(footer);
    }
    const top = new RealmNode(buffer, Number(topRef));

    const names = top.child(GROUP_TABLE_NAMES_INDEX);
    const tables = top.child(GROUP_TABLES_INDEX);
    if (!names || !tables) {
      throw new Error("Realm file does not contain any tables");
    }
    this.tables = tables;
    for (let i = 0; i < names.size; i++) {
      const name = this.readShortString(names, i) ?? "";
      this.tableNames.push(name);
      this.tableIndexByName.set(name, i);
    }
  }

  /**
   * Returns the names of all tables. Tables of Realm objects are prefixed with `class_` (e.g. `class_BeatmapInfo`).
   */
  getTableNames(): string[] {
    return [...this.tableNames];
  }

  hasTable(tableName: string): boolean {
    return this.tableIndexByName.has(tableName);
  }

  getColumns(tableName: string): RealmColumn[] {
    const tableTop = this.getTableTop(tableName);
    const spec = tableTop.child(TABLE_SPEC_INDEX);
    if (!spec) return [];
    const types = spec.child(SPEC_TYPES_INDEX);
    const names = spec.child(SPEC_NAMES_INDEX);
    const attributes = spec.child(SPEC_ATTRIBUTES_INDEX);
    const enumKeys = spec.size > SPEC_ENUM_KEYS_INDEX ? spec.child(SPEC_ENUM_KEYS_INDEX) : null;
    const columnKeys = spec.child(SPEC_COLUMN_KEYS_INDEX);
    if (!types || !names || !attributes || !columnKeys) {
      throw new Error(`Table ${tableName} has an invalid spec`);
    }
    const oppositeTables = tableTop.child(TABLE_OPPOSITE_TABLE_INDEX);

    const columns: RealmColumn[] = [];
    for (let i = 0; i < types.size; i++) {
      const type = types.get(i);
      const attribute = attributes.get(i);
      // ColKey = index (16 bits) | type (6 bits) | attributes (8 bits) | tag
      const leafIndex = columnKeys.get(i) & 0xffff;
      const column: RealmColumn = {
        // Backlink columns come last and have no names
        name: i < names.size ? this.readShortString(names, i) ?? "" : "",
        type,
        nullable: (attribute & ColumnAttribute.Nullable) !== 0,
        list: (attribute & ColumnAttribute.List) !== 0,
        leafIndex,
        enumKeysRef: enumKeys && i < enumKeys.size ? enumKeys.getRef(i) : 0,
      };
      if ((type === RealmColumnType.Link || type === RealmColumnType.BackLink) && oppositeTables) {
        // Only the lower 16 bits of the `TableKey` are the index of the table
        column.targetTable = this.tableNames[oppositeTables.get(leafIndex) & 0xffff];
      }
      columns.push(column);
    }
    return columns;
  }

  /**
   * Reads all objects of the given table. Only the given columns are read in order to save some time.
   *
   * Links are returned as the key of the target object (or `null`), lists are returned as arrays.
   */
  readTable(tableName: string, columnNames: string[]): RealmObject[] {
    const allColumns = this.getColumns(tableName);
    const columns = columnNames.map((name) => {
      const column = allColumns.find((c) => c.name === name);
      if (!column) {
        throw new Error(`Column ${name} does not exist in table ${tableName}`);
      }
      return column;
    });

    const objects: RealmObject[] = [];
    const root = this.getTableTop(tableName).child(TABLE_CLUSTER_TREE_INDEX);
    if (root) {
      this.traverseClusters(root, 0, (cluster, keyOffset) => this.readCluster(cluster, keyOffset, columns, objects));
    }
    return objects;
  }

  private getTableTop(tableName: string): RealmNode {
    const index = this.tableIndexByName.get(tableName);
    const tableTop = index === undefined ? null : this.tables.child(index);
    if (!tableTop) {
      throw new Error(`Table ${tableName} does not exist`);
    }
    return tableTop;
  }

  private traverseClusters(node: RealmNode, keyOffset: number, visit: (cluster: RealmNode, offset: number) => void) {
    if (!node.isInnerBPTreeNode) {
      visit(node, keyOffset);
      return;
    }
    const keys = node.child(CLUSTER_INNER_KEYS_INDEX);
    const shift = node.getTagged(CLUSTER_INNER_SUB_TREE_DEPTH_INDEX) * CLUSTER_NODE_SHIFT_FACTOR;
    for (let i = 0; i + CLUSTER_INNER_FIRST_CHILD_INDEX < node.size; i++) {
      const child = node.child(i + CLUSTER_INNER_FIRST_CHILD_INDEX);
      if (!child) continue;
      const childOffset = keys ? keys.getUnsigned(i) : i * Math.pow(2, shift);
      this.traverseClusters(child, keyOffset + childOffset, visit);
    }
  }

  private readCluster(cluster: RealmNode, keyOffset: number, columns: RealmColumn[], objects: RealmObject[]) {
    // Either a ref to the keys, or the number of objects as a tagged integer if the keys are 0, 1, 2, ...
    const keys = cluster.child(CLUSTER_KEYS_INDEX);
    const size = keys ? keys.size : cluster.getTagged(CLUSTER_KEYS_INDEX);

    const firstObject = objects.length;
    for (let i = 0; i < size; i++) {
      objects.push({ key: keyOffset + (keys ? keys.getUnsigned(i) : i) });
    }
    for (const column of columns) {
      const leaf = cluster.child(CLUSTER_FIRST_COLUMN_INDEX + column.leafIndex);
      for (let i = 0; i < size; i++) {
        objects[firstObject + i][column.name] = leaf ? this.readValue(leaf, i, column) : null;
      }
    }
  }

  private readValue(leaf: RealmNode, index: number, column: RealmColumn): RealmValue {
    if (column.list) {
      const tree = leaf.child(index);
      const values: RealmValue[] = [];
      if (tree) {
        this.traverseBPTree(tree, (treeLeaf) => {
          for (let i = 0; i < treeLeaf.size; i++) {
            const value = this.readListElement(treeLeaf, i, column);
            if (value !== undefined) values.push(value);
          }
        });
      }
      return values;
    }
    switch (column.type) {
      case RealmColumnType.Int:
        return this.readInt(leaf, index, column.nullable);
      case RealmColumnType.Bool: {
        const value = leaf.get(index);
        return column.nullable && value === BOOL_NULL_VALUE ? null : value !== 0;
      }
      case RealmColumnType.String:
        return this.readString(leaf, index, column.enumKeysRef);
      case RealmColumnType.Timestamp:
        return this.readTimestamp(leaf, index);
      case RealmColumnType.Link: {
        // `ArrayKey` stores key + 1 so that 0 can be used as null. Negative keys are unresolved links (tombstones).
        const key = leaf.get(index) - 1;
        return key < 0 ? null : key;
      }
      case RealmColumnType.UUID:
        return this.readUUID(leaf, index);
    }
    throw new Error(`Reading column ${column.name} with type ${column.type} is not supported`);
  }

  // Returns `undefined` for elements that should be skipped
  private readListElement(leaf: RealmNode, index: number, column: RealmColumn): RealmValue | undefined {
    switch (column.type) {
      case RealmColumnType.Link: {
        // Lists of links use `ArrayKeyNonNullable` (no +1 offset), unresolved links are negative
        const key = leaf.get(index);
        return key < 0 ? undefined : key;
      }
      case RealmColumnType.Int:
        return this.readInt(leaf, index, column.nullable);
      case RealmColumnType.String:
        return this.readString(leaf, index, 0);
    }
    throw new Error(`Reading list column ${column.name} with type ${column.type} is not supported`);
  }

  private traverseBPTree(node: RealmNode, visitLeaf: (leaf: RealmNode) => void) {
    if (!node.isInnerBPTreeNode) {
      visitLeaf(node);
      return;
    }
    // First element is the offsets (or elements per child), last element is the total size.
    for (let i = 1; i < node.size - 1; i++) {
      const child = node.child(i);
      if (child) this.traverseBPTree(child, visitLeaf);
    }
  }

  private readInt(leaf: RealmNode, index: number, nullable: boolean): number | null {
    if (!nullable) return leaf.get(index);
    // `ArrayIntNull` stores the value that represents null at the first position
    const value = leaf.get(index + 1);
    return value === leaf.get(0) ? null : value;
  }

  private readString(leaf: RealmNode, index: number, enumKeysRef: number): string | null {
    if (!leaf.hasRefs) {
      if (leaf.widthType === WidthType.Multiply) {
        return this.readShortString(leaf, index);
      }
      // Enumerated strings: the leaf contains indices into the list of unique values
      if (enumKeysRef === 0) {
        throw new Error("Enumerated string column without enum keys");
      }
      return this.readString(new RealmNode(this.buffer, enumKeysRef), leaf.get(index), 0);
    }
    if (!leaf.contextFlag) {
      // Medium strings (`ArraySmallBlobs`): [offsets, blob, nulls]
      const offsets = leaf.child(0);
      const blob = leaf.child(1);
      const nulls = leaf.size > 2 ? leaf.child(2) : null;
      if (!offsets || !blob || (nulls && nulls.get(index) !== 0)) return null;
      const begin = index > 0 ? offsets.get(index - 1) : 0;
      const end = offsets.get(index);
      // Strings are zero terminated
      return this.buffer.toString("utf8", blob.data + begin, blob.data + Math.max(begin, end - 1));
    }
    // Big strings (`ArrayBigBlobs`): every string is in its own blob
    const blob = leaf.child(index);
    if (!blob) return null;
    if (blob.contextFlag) {
      throw new Error("Strings that are split into multiple blobs are not supported");
    }
    return this.buffer.toString("utf8", blob.data, blob.data + Math.max(0, blob.size - 1));
  }

  // `ArrayStringShort`: every string occupies `width` bytes, the last byte contains the number of unused bytes
  private readShortString(leaf: RealmNode, index: number): string | null {
    const { width } = leaf;
    if (width === 0) return null;
    const start = leaf.data + index * width;
    const length = width - 1 - this.buffer[start + width - 1];
    if (length < 0) return null;
    return this.buffer.toString("utf8", start, start + length);
  }

  // `ArrayTimestamp`: [seconds (nullable), nanoseconds]
  private readTimestamp(leaf: RealmNode, index: number): Date | null {
    const seconds = leaf.child(0);
    const nanoseconds = leaf.child(1);
    if (!seconds) return null;
    const s = this.readInt(seconds, index, true);
    if (s === null) return null;
    const ns = nanoseconds ? nanoseconds.get(index) : 0;
    return new Date(s * 1000 + Math.floor(ns / 1e6));
  }

  // `ArrayFixedBytes`: blocks of a null bit vector followed by 8 values
  private readUUID(leaf: RealmNode, index: number): string | null {
    if (leaf.width === 0) return null;
    const block = leaf.data + Math.floor(index / 8) * UUID_BLOCK_SIZE;
    const position = index % 8;
    if ((this.buffer[block] & (1 << position)) !== 0) return null;
    const start = block + 1 + position * UUID_SIZE;
    const hex = this.buffer.toString("hex", start, start + UUID_SIZE);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
