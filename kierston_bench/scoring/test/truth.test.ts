import { beforeAll, describe, expect, test } from "bun:test";
import { TruthIndex, resolvesTo, settledId } from "../src/truth.ts";
import { writeSimData } from "./fixtures/world.ts";

let truth: TruthIndex;
beforeAll(async () => {
  truth = new TruthIndex(await writeSimData());
});

describe("people", () => {
  test("an SSN names its holder, punctuation or not", async () => {
    expect((await truth.resolve("person", "111-22-3333")).ids).toEqual(["1"]);
    expect((await truth.resolve("person", "111223333")).ids).toEqual(["1"]);
  });

  test("a mobile number reaches its subscriber through either register", async () => {
    expect((await truth.resolve("person", "(610) 000-0001")).ids).toEqual(["1"]);
    expect((await truth.resolve("person", "+1 610 000 0022")).ids).toEqual(["2"]);
  });

  test("an IMSI names the subscriber", async () => {
    const resolved = await truth.resolve("person", "310150123456789");
    expect(resolved.ids).toEqual(["2"]);
    expect(resolved.via).toBe("imsi");
  });

  test("a messenger handle names its account holder", async () => {
    expect((await truth.resolve("person", "@birdy")).ids).toEqual(["3"]);
    expect((await truth.resolve("person", "skeet:birdy")).ids).toEqual(["3"]);
  });

  test("a name may name several people, and both are kept", async () => {
    const resolved = await truth.resolve("person", "Alan Turing");
    expect(resolved.ids).toEqual(["3", "4"]);
    expect(settledId(resolved, "strict")).toBeNull();
    expect(resolvesTo(resolved, new Set(["3"]), "strict")).toBe(false);
    expect(resolvesTo(resolved, new Set(["3"]), "lenient")).toBe(true);
  });

  test("a date of birth separates two people of one name", async () => {
    expect((await truth.resolve("person", "Alan Turing 1980-06-23")).ids).toEqual(["3"]);
  });

  test("the simulator's own id resolves to itself", async () => {
    expect((await truth.resolve("person", 2)).ids).toEqual(["2"]);
  });
});

describe("places", () => {
  test("the v: prefix and case do not matter", async () => {
    expect((await truth.resolve("place", "way/200")).ids).toEqual(["way/200"]);
    expect((await truth.resolve("place", "V:WAY/200")).ids).toEqual(["way/200"]);
  });

  test("a venue name reaches its id", async () => {
    expect((await truth.resolve("place", "Hop Po")).ids).toEqual(["way/200"]);
  });

  test("a street address reaches its dwelling", async () => {
    expect((await truth.resolve("place", "1 Bridge Street, Allentown, PA 18103")).ids).toEqual(["way/100"]);
  });

  test("a name and an address together settle what neither settles alone", async () => {
    expect((await truth.resolve("place", "North 10th Street, Allentown, PA 18102")).ids).toEqual(["way/400", "way/401"]);
    const resolved = await truth.resolve("place", "Milano Furniture, North 10th Street, Allentown, PA 18102");
    expect(resolved.ids).toEqual(["way/401"]);
    expect(resolved.via).toBe("name+address");
  });

  test("a name paired with somebody else's address names nothing", async () => {
    expect((await truth.resolve("place", "Hop Po, North 10th Street, Allentown, PA 18102")).ids).toEqual([]);
  });
});

describe("vehicles", () => {
  test("a plate reaches the VIN, and the VIN its keeper", async () => {
    expect((await truth.resolve("vehicle", "lav1459")).ids).toEqual(["1HGCM82633A004352"]);
    expect(await truth.vehicleOwner("LAV-1459")).toEqual({ vin: "1HGCM82633A004352", owner: "1", household: "9" });
  });
});

test("a household lists its members", async () => {
  expect(await truth.membersOfHousehold("9")).toEqual(["1", "2"]);
});

describe("truth snapshot", () => {
  test("a series' snapshot resolves every claim as the sim_data it was taken from", async () => {
    const { takeTruthSnapshot } = await import("../src/truth_snapshot.ts");
    const dir = await writeSimData();
    const live = new TruthIndex(dir);
    const frozen = new TruthIndex(JSON.parse(JSON.stringify(await takeTruthSnapshot(dir))));
    const claims: [Parameters<TruthIndex["resolve"]>[0], string][] = [
      ["person", "111-22-3333"], ["person", "+1 610 000 0022"], ["person", "310150123456789"], ["person", "@birdy"],
      ["person", "Alan Turing"], ["person", "Alan Turing 1999-09-09"], ["person", "Mary Somerville"],
      ["place", "1 Bridge Street"], ["place", "Hop Po"], ["place", "North 10th Street, Allentown, PA 18102"],
      ["vehicle", "LAV-1459"], ["vehicle", "1HGCM82633A004352"], ["household", "9"],
    ];
    for (const [kind, value] of claims) expect(await frozen.resolve(kind, value)).toEqual(await live.resolve(kind, value));
    for (const value of ['{"name":"Mary Somerville","dob":"1978-12-26"}', '{"ssn":"222-33-4444","name":"Grace Hopper","dob":"1985-05-05"}', '{"name":"Sofia Kovalevskaya","dob":"1988-01-15"}'])
      expect(await frozen.resolveIdentity(value)).toEqual(await live.resolveIdentity(value));
    expect(await frozen.householdOf("1")).toEqual(await live.householdOf("1"));
    expect(await frozen.vehicleOwner("LAV-1459")).toEqual(await live.vehicleOwner("LAV-1459"));
  });

  test("the source is never an absolute host path, and a nested register value is refused, not flattened", async () => {
    const { snapshotSource, takeTruthSnapshot } = await import("../src/truth_snapshot.ts");
    const { resolve } = await import("node:path");
    const dir = await writeSimData();
    const snapshot = await takeTruthSnapshot(dir);
    expect(snapshot.source.startsWith("/")).toBe(false);
    expect(snapshotSource(resolve(import.meta.dir, "../../../kierston/sim_data"))).toBe("kierston/sim_data");
    const identity = await Bun.file(`${dir}/identity.json`).json() as { identities: Record<string, Record<string, unknown>> };
    Object.values(identity.identities)[0]!.mobile = ["+1 610 000 0022"];
    await Bun.write(`${dir}/identity.json`, JSON.stringify(identity));
    await expect(takeTruthSnapshot(dir)).rejects.toThrow("column mobile holds a list");
  });
});
