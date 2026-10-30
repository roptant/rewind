import { RealmColumnType, RealmReader } from "./RealmReader";
import { buildRealmFile, TableDefinition } from "../test/RealmFileBuilder";

const users: TableDefinition = {
  name: "class_User",
  columns: [{ name: "Name", type: RealmColumnType.String, nullable: true }],
  rows: [{ Name: "peppy" }, { Name: "abstrakt" }, { Name: "Cookiezi" }, { Name: "WhiteCat" }, { Name: "mrekk" }],
};

const items: TableDefinition = {
  name: "class_Item",
  columns: [
    { name: "ID", type: RealmColumnType.UUID },
    { name: "Title", type: RealmColumnType.String, nullable: true },
    { name: "Description", type: RealmColumnType.String, nullable: true, strings: "medium" },
    { name: "Notes", type: RealmColumnType.String, nullable: true, strings: "big" },
    { name: "Small", type: RealmColumnType.Int },
    { name: "Large", type: RealmColumnType.Int },
    { name: "Optional", type: RealmColumnType.Int, nullable: true },
    { name: "Enabled", type: RealmColumnType.Bool },
    { name: "Maybe", type: RealmColumnType.Bool, nullable: true },
    { name: "Owner", type: RealmColumnType.Link, nullable: true, target: "class_User" },
    { name: "Friends", type: RealmColumnType.Link, list: true, target: "class_User" },
    { name: "Created", type: RealmColumnType.Timestamp, nullable: true },
  ],
  rows: [
    {
      ID: "0555c76a-cc6b-4bb4-9548-df76ba72ef25",
      Title: "Blue Zenith",
      Description: "A description that is longer than the short strings",
      Notes: "x".repeat(100),
      Small: 3,
      Large: 727_000_000_000,
      Optional: 42,
      Enabled: true,
      Maybe: true,
      Owner: 1,
      Friends: [0, 2],
      Created: new Date("2021-11-02T12:34:56.789Z"),
    },
    {
      ID: "81f02cd3-eec6-4865-ac23-fae26a386187",
      Title: "東方",
      Description: null,
      Notes: null,
      Small: 0,
      Large: -5,
      Optional: null,
      Enabled: false,
      Maybe: null,
      Owner: null,
      Friends: [],
      Created: null,
    },
    {
      ID: "2991cfd8-2140-469a-bcb9-2ec23fbce4ad",
      Title: null,
      Description: "日本語の説明 🎵",
      Notes: "Notes with ünïcödé",
      Small: 15,
      Large: 70_000,
      Optional: -1,
      Enabled: true,
      Maybe: false,
      Owner: 4,
      Friends: [4, 3, 2, 1, 0],
      Created: new Date(0),
    },
  ],
  // The second cluster uses explicit keys
  clusterSizes: [2, 1],
};

describe("RealmReader", () => {
  const reader = new RealmReader(buildRealmFile([users, items]));

  it("reads the table names", () => {
    expect(reader.fileFormatVersion).toEqual(24);
    expect(reader.getTableNames()).toEqual(["class_User", "class_Item"]);
    expect(reader.hasTable("class_Item")).toBe(true);
    expect(reader.hasTable("class_Nothing")).toBe(false);
  });

  it("reads the columns", () => {
    const columns = reader.getColumns("class_Item");
    expect(columns.map((c) => c.name)).toEqual([...items.columns.map((c) => c.name), ""]);

    const owner = columns.find((c) => c.name === "Owner");
    expect(owner).toMatchObject({ type: RealmColumnType.Link, nullable: true, list: false, targetTable: "class_User" });
    const friends = columns.find((c) => c.name === "Friends");
    expect(friends).toMatchObject({ type: RealmColumnType.Link, list: true, targetTable: "class_User" });
    // The backlink column has no name
    expect(columns[columns.length - 1].type).toEqual(RealmColumnType.BackLink);
  });

  it("reads the values of all objects", () => {
    const objects = reader.readTable(
      "class_Item",
      items.columns.map((c) => c.name),
    );
    const userKeys = reader.readTable("class_User", ["Name"]).map((u) => u.key);

    expect(objects.map((o) => o.key)).toEqual([0, 1, 257]);
    items.rows.forEach((row, i) => {
      const object = objects[i];
      for (const [column, value] of Object.entries(row)) {
        if (column === "Owner") {
          expect(object.Owner).toEqual(value === null ? null : userKeys[value as number]);
        } else if (column === "Friends") {
          expect(object.Friends).toEqual((value as number[]).map((u) => userKeys[u]));
        } else {
          expect(object[column]).toEqual(value);
        }
      }
    });
  });

  it("only reads the requested columns", () => {
    const objects = reader.readTable("class_User", ["Name"]);
    expect(objects).toEqual(users.rows.map((u, i) => ({ key: i, Name: u.Name })));
  });

  it("throws if the table or the column does not exist", () => {
    expect(() => reader.readTable("class_Nothing", [])).toThrow();
    expect(() => reader.readTable("class_User", ["Nothing"])).toThrow();
  });

  it("reads files in streaming form", () => {
    const streamed = new RealmReader(buildRealmFile([users], { streamingForm: true }));
    expect(streamed.readTable("class_User", ["Name"]).map((u) => u.Name)).toEqual(users.rows.map((u) => u.Name));
  });

  it("rejects files that are not supported", () => {
    expect(() => new RealmReader(Buffer.from("not a realm file at all :("))).toThrow("mnemonic");
    expect(() => new RealmReader(buildRealmFile([users], { fileFormatVersion: 9 }))).toThrow("version 9");
  });
});
