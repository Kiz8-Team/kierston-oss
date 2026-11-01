import { describe, expect, test } from "bun:test";
import { scheduleDay } from "./planner.ts";
import type { ActivityIntent, TransitionPlanner, TransitionRequest, TravelEvent } from "./types.ts";
import type { Place } from "../transport/index.ts";

const place = (id: string, x: number): Place => ({ id, kind: id === "home" ? "home" : "venue", label: id, lat: 0, lon: x });
const home = place("home", 0);
const work = place("work", 1);
const shop = place("shop", 0.5);

class FakeMobility implements TransitionPlanner {
  readonly requests: TransitionRequest[] = [];

  transition(request: TransitionRequest) {
    this.requests.push(request);
    const minutes = request.from.id === request.to.id ? 0 : Math.abs(request.to.lon - request.from.lon) * 10;
    const event: TravelEvent = {
      kind: "travel", journeyId: request.override?.journeyId ?? `${request.from.id}>${request.to.id}@${request.depart}`,
      purpose: request.purpose, mode: request.override?.mode ?? "car", from: request.from, to: request.to,
      start: request.depart, end: request.depart + minutes, kilometres: minutes / 10, estimated: false,
    };
    return { events: minutes ? [event] : [], arrive: request.depart + minutes, vehicleAt: request.to };
  }
  latestDeparture(request: Omit<TransitionRequest, "depart"> & { arriveBy: number }) {
    return request.arriveBy - Math.abs(request.to.lon - request.from.lon) * 10;
  }
}

const fixed = (id: string, start: number, end: number, policy: ActivityIntent["policy"] = "required"): ActivityIntent => ({
  id, source: "work", place: work, timing: { kind: "fixed", start, end }, policy, purpose: "work",
});

describe("scheduler gap planner", () => {
  test("treats yesterday's continuation as authoritative", () => {
    const carried: TravelEvent = {
      kind: "travel", journeyId: "carried-home", purpose: "home", mode: "car",
      from: work, to: home, start: 120, end: 130, kilometres: 1, estimated: false,
    };
    const sleep: ActivityIntent = {
      id: "redrawn-sleep", source: "sleep", place: home,
      timing: { kind: "window", earliest: -100, latest: 100, duration: 200 },
      policy: "missable", purpose: "home",
    };
    const day = scheduleDay(new FakeMobility(), {
      person: 1,
      day: 2,
      home,
      intents: [sleep, fixed("future-work", 200, 300)],
      opening: {
        timeline: [{
          kind: "stay", activityId: "carried-work", source: "work", place: work,
          start: -60, end: 120, policy: "required",
        }, carried],
        at: 130,
        place: home,
        vehicleAt: home,
      },
    });
    expect(day.timeline.slice(0, 2)).toEqual([
      expect.objectContaining({ activityId: "carried-work", start: -60, end: 120 }),
      carried,
    ]);
    expect(day.rejected.map((row) => row.intent.id)).toContain("redrawn-sleep");
    expect(day.timeline.some((event) => event.kind === "stay" && event.activityId === "future-work")).toBeTrue();
  });

  test("rejects a zero-duration activity instead of exporting a point stay", () => {
    const day = scheduleDay(new FakeMobility(), {
      person: 1, day: 1, home, intents: [fixed("point", 100, 100)],
    });
    expect(day.timeline).toHaveLength(0);
    expect(day.rejected[0]?.detail).toContain("positive duration");
  });

  test("keeps an authoritative no-vehicle opening instead of inventing a car at home", () => {
    const mobility = new FakeMobility();
    scheduleDay(mobility, {
      person: 1,
      day: 2,
      home,
      intents: [fixed("future-work", 200, 300)],
      opening: { timeline: [], at: 0, place: home, vehicleAt: null },
    });
    expect(mobility.requests[0]?.vehicleAt).toBeNull();
  });

  test("keeps a required anchor and rejects only the conflicting optional activity", () => {
    const optional = { ...fixed("optional", 100, 200, "optional"), source: "stop" as const, place: shop };
    const day = scheduleDay(new FakeMobility(), { person: 1, day: 1, home, intents: [optional, fixed("work", 150, 300)] });
    expect(day.timeline.filter((event) => event.kind === "stay").map((event) => event.activityId)).toEqual(["work"]);
    expect(day.rejected.map((entry) => entry.intent.id)).toEqual(["optional"]);
  });

  test("rejects an unfit window without erasing surrounding anchors", () => {
    const stop: ActivityIntent = {
      id: "stop", source: "stop", place: shop, timing: { kind: "window", earliest: 90, latest: 105, duration: 10 },
      policy: "optional", purpose: "stop",
    };
    const day = scheduleDay(new FakeMobility(), { person: 1, day: 1, home, intents: [fixed("work", 100, 200), stop] });
    expect(day.timeline.some((event) => event.kind === "stay" && event.activityId === "work")).toBeTrue();
    expect(day.rejected[0]?.intent.id).toBe("stop");
  });

  test("inserts a flexible activity when both routed sides fit", () => {
    const stop: ActivityIntent = {
      id: "stop", source: "stop", place: shop, timing: { kind: "window", earliest: 10, latest: 80, duration: 20 },
      policy: "optional", purpose: "stop",
    };
    const day = scheduleDay(new FakeMobility(), { person: 1, day: 1, home, intents: [stop, fixed("work", 100, 200)] });
    expect(day.timeline.filter((event) => event.kind === "stay").map((event) => event.activityId)).toEqual(["stop", "work"]);
    expect(day.rejected).toHaveLength(0);
  });

  test("compresses a preferred window against the following anchor", () => {
    const sleep: ActivityIntent = {
      id: "sleep", source: "sleep", place: home,
      timing: { kind: "window", earliest: 0, latest: 600, duration: 210, preferredDuration: 600 },
      policy: "missable", purpose: "home",
    };
    const anchor = fixed("anchor", 480, 500);
    const result = scheduleDay(new FakeMobility(), { person: 1, day: 1, home, intents: [sleep, anchor] });
    const stay = result.timeline.find((event) => event.kind === "stay" && event.activityId === "sleep");
    expect(stay).toMatchObject({ start: 0, end: 470 });
  });

  test("is deterministic regardless of input order", () => {
    const intents = [fixed("b", 200, 250), fixed("a", 100, 150)];
    const a = scheduleDay(new FakeMobility(), { person: 1, day: 1, home, intents });
    const b = scheduleDay(new FakeMobility(), { person: 1, day: 1, home, intents: [...intents].reverse() });
    expect(a).toEqual(b);
  });

  test("a required anchor displaces every weaker overlapping activity", () => {
    const intents = [fixed("a", 100, 140, "optional"), fixed("b", 150, 190, "missable"), fixed("work", 120, 180)];
    const day = scheduleDay(new FakeMobility(), { person: 1, day: 1, home, intents });
    expect(day.timeline.filter((event) => event.kind === "stay").map((event) => event.activityId)).toEqual(["work"]);
    expect(day.rejected.map((entry) => entry.intent.id).sort()).toEqual(["a", "b"]);
  });

  test("does not mutate intents or their timing", () => {
    const intent = fixed("work", 100, 200);
    const snapshot = structuredClone(intent);
    scheduleDay(new FakeMobility(), { person: 1, day: 1, home, intents: [intent] });
    expect(intent).toEqual(snapshot);
  });
});
