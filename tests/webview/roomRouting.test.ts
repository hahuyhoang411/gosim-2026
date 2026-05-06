import { describe, expect, test } from "bun:test";
import { Direction, type Seat } from "../../webview-ui/src/office/types.js";
import { OfficeState } from "../../webview-ui/src/office/engine/officeState.js";
import {
  ROOM_ANCHORS,
  chooseSeatForRoom,
  reportRoomForSubagent,
  roomForSeatId,
  roomForToolStatus,
} from "../../webview-ui/src/office/roomRouting.js";

function seat(uid: string, assigned = false): Seat {
  return { uid, seatCol: 1, seatRow: 1, facingDir: Direction.DOWN, assigned };
}

describe("semantic room routing", () => {
  test("maps default office seat ids to semantic rooms", () => {
    expect(roomForSeatId("conf-chair-1")).toBe("debate");
    expect(roomForSeatId("off2-chair")).toBe("research");
    expect(roomForSeatId("off3-chair-a")).toBe("coding");
    expect(roomForSeatId("main-chair-1")).toBe("brainstorm");
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

  test("routes Kimi tool status to semantic work rooms", () => {
    expect(roomForToolStatus("Searching the web")).toBe("research");
    expect(roomForToolStatus("Fetching web content")).toBe("research");
    expect(roomForToolStatus("Running: bun test")).toBe("coding");
    expect(roomForToolStatus("Editing App.tsx")).toBe("coding");
    expect(roomForToolStatus("Subtask: compare the references")).toBe("brainstorm");
    expect(roomForToolStatus("Waiting for your answer")).toBeNull();
  });

  test("keeps dedicated room anchors distinct for in-world labels and boards", () => {
    expect(ROOM_ANCHORS.research).not.toEqual(ROOM_ANCHORS.debate);
    expect(ROOM_ANCHORS.brainstorm).not.toEqual(ROOM_ANCHORS.debate);
    expect(reportRoomForSubagent()).toBe("debate");
  });

  test("OfficeState moves an agent to a semantic room seat", () => {
    const office = new OfficeState();
    office.addAgent(1);

    expect(office.moveAgentToRoom(1, "research")).toBe(true);
    expect(roomForSeatId(office.characters.get(1)?.seatId ?? "")).toBe("research");
  });

  test("OfficeState can move a subagent to an action room", () => {
    const office = new OfficeState();
    office.addAgent(1);
    const subagentId = office.addSubagent(1, "task-1");

    expect(office.moveAgentToRoom(subagentId, "research")).toBe(true);
    expect(roomForSeatId(office.characters.get(subagentId)?.seatId ?? "")).toBe("research");
  });

  test("inactive subagents can still be sent back to the PI report room", () => {
    const office = new OfficeState();
    office.addAgent(1);
    const subagentId = office.addSubagent(1, "task-1");
    office.moveAgentToRoom(subagentId, "research");

    office.setAgentActive(subagentId, false);
    expect(office.moveAgentToRoom(subagentId, reportRoomForSubagent())).toBe(true);

    expect(roomForSeatId(office.characters.get(subagentId)?.seatId ?? "")).toBe("debate");
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
