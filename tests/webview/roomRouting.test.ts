import { describe, expect, test } from "bun:test";
import { Direction, type Seat } from "../../webview-ui/src/office/types.js";
import { OfficeState } from "../../webview-ui/src/office/engine/officeState.js";
import {
  chooseSeatForRoom,
  roomForSeatId,
  roomForToolStatus,
  roomsForScenario,
} from "../../webview-ui/src/office/roomRouting.js";

function seat(uid: string, assigned = false): Seat {
  return { uid, seatCol: 1, seatRow: 1, facingDir: Direction.DOWN, assigned };
}

describe("semantic room routing", () => {
  test("maps default office seat ids to semantic rooms", () => {
    expect(roomForSeatId("conf-chair-1")).toBe("debate");
    expect(roomForSeatId("off2-chair")).toBe("research");
    expect(roomForSeatId("off3-chair-a")).toBe("coding");
    expect(roomForSeatId("main-chair-1")).toBe("general");
    expect(roomForSeatId("break-chair-1")).toBe("idle");
  });

  test("chooses the current room seat before stealing a different seat", () => {
    const seats = new Map<string, Seat>([
      ["off2-chair", seat("off2-chair", true)],
      ["off1-chair-a", seat("off1-chair-a", false)],
    ]);

    expect(chooseSeatForRoom("research", seats, "off2-chair")).toBe("off2-chair");
  });

  test("chooses the first free preferred seat for a target room", () => {
    const seats = new Map<string, Seat>([
      ["off2-chair", seat("off2-chair", true)],
      ["off1-chair-a", seat("off1-chair-a", false)],
      ["off1-chair-b", seat("off1-chair-b", false)],
    ]);

    expect(chooseSeatForRoom("research", seats, null)).toBe("off1-chair-a");
  });

  test("routes web search statuses to the research room", () => {
    expect(roomForToolStatus("Searching the web")).toBe("research");
    expect(roomForToolStatus("Fetching web content")).toBe("research");
    expect(roomForToolStatus("Running: bun test")).toBeNull();
  });

  test("maps scenario presets to room assignments", () => {
    expect(roomsForScenario("debate", [1, 2, 3])).toEqual({ 1: "debate", 2: "debate", 3: "debate" });
    expect(roomsForScenario("brainstorm", [1, 2])).toEqual({ 1: "brainstorm", 2: "brainstorm" });
    expect(roomsForScenario("search_squad", [1, 2])).toEqual({ 1: "research", 2: "research" });
    expect(roomsForScenario("solo_research", [1, 2])).toEqual({ 1: "research" });
  });

  test("OfficeState moves an agent to a semantic room seat", () => {
    const office = new OfficeState();
    office.addAgent(1);

    expect(office.moveAgentToRoom(1, "research")).toBe(true);
    expect(roomForSeatId(office.characters.get(1)?.seatId ?? "")).toBe("research");
  });

  test("default layout exposes break-room seats for idle routing", () => {
    const office = new OfficeState();
    office.addAgent(1);

    expect(office.seats.has("break-chair-1")).toBe(true);
    expect(office.moveAgentToRoom(1, "idle")).toBe(true);
    expect(roomForSeatId(office.characters.get(1)?.seatId ?? "")).toBe("idle");
  });

  test("reassigning to an occupied seat preserves the original assignment", () => {
    const office = new OfficeState();
    office.addAgent(1);
    office.addAgent(2);
    const originalSeat = office.characters.get(1)?.seatId;
    const occupiedSeat = office.characters.get(2)?.seatId;

    expect(originalSeat).toBeTruthy();
    expect(occupiedSeat).toBeTruthy();
    office.reassignSeat(1, occupiedSeat!);

    expect(office.characters.get(1)?.seatId).toBe(originalSeat);
    expect(office.seats.get(originalSeat!)?.assigned).toBe(true);
  });
});
