import { describe, expect, test } from "bun:test";
import { getCatalogEntry } from "../../webview-ui/src/office/layout/furnitureCatalog.js";
import {
  createDefaultLayout,
  migrateLayoutColors,
} from "../../webview-ui/src/office/layout/layoutSerializer.js";
import {
  findInteractiveFurnitureAtTile,
  isBlackboardFurniture,
  roomForBlackboardFurniture,
} from "../../webview-ui/src/office/interactiveFurniture.js";
import { FurnitureType } from "../../webview-ui/src/office/types.js";

describe("interactive blackboard furniture", () => {
  test("registers an original blackboard furniture sprite", () => {
    const entry = getCatalogEntry(FurnitureType.BLACKBOARD);

    expect(entry?.label).toBe("Blackboard");
    expect(entry?.footprintW).toBe(2);
    expect(entry?.footprintH).toBe(1);
    expect(entry?.sprite.length).toBeGreaterThanOrEqual(16);
    expect(entry?.sprite[0].length).toBe(32);
  });

  test("default room boards are blackboard furniture", () => {
    const layout = createDefaultLayout();
    const boardUids = ["conf-wb", "off2-wb", "off4-wb", "main-wb"];

    expect(
      boardUids.map((uid) => layout.furniture.find((item) => item.uid === uid)?.type),
    ).toEqual([
      FurnitureType.BLACKBOARD,
      FurnitureType.BLACKBOARD,
      FurnitureType.BLACKBOARD,
      FurnitureType.BLACKBOARD,
    ]);
  });

  test("hit-tests blackboards as interactive furniture", () => {
    const layout = createDefaultLayout();
    const board = layout.furniture.find((item) => item.uid === "conf-wb");

    expect(board).toBeTruthy();
    expect(isBlackboardFurniture(board!)).toBe(true);
    expect(findInteractiveFurnitureAtTile(layout, board!.col, board!.row)?.uid).toBe("conf-wb");
  });

  test("maps clicked default blackboards to their semantic rooms", () => {
    const layout = createDefaultLayout();
    const rooms = Object.fromEntries(
      layout.furniture
        .filter(isBlackboardFurniture)
        .map((item) => [item.uid, roomForBlackboardFurniture(item)]),
    );

    expect(rooms).toMatchObject({
      "conf-wb": "debate",
      "off2-wb": "research",
      "off4-wb": "coding",
      "main-wb": "general",
    });
  });

  test("migrates persisted default whiteboards into blackboards", () => {
    const layout = createDefaultLayout();
    const persisted = {
      ...layout,
      furniture: layout.furniture.map((item) =>
        item.uid === "conf-wb" ? { ...item, type: FurnitureType.WHITEBOARD } : item
      ),
    };

    expect(migrateLayoutColors(persisted).furniture.find((item) => item.uid === "conf-wb")?.type)
      .toBe(FurnitureType.BLACKBOARD);
  });
});
