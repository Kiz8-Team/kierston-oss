/**
 * A fixed plate reader's two views of a routed day.
 *
 * `truth` is one row for every physical vehicle passage across a camera's
 * directed edge. `observation` is what that camera made of the passage,
 * including an explicit null result where a real camera log would be silent.
 * The two share a correlation id solely so a simulation audit can compare
 * them; it is not something the camera perceived.
 *
 * A day file owns the passes that happen on its own calendar date. A leg
 * that crosses midnight is written in full by both the day it started and
 * the day it finished (yesterday's committed leg is carried into today's
 * plan as-is), and a plan that runs on past midnight is re-planned by
 * tomorrow from the boundary state — so a pass at second 86,400 or later
 * would be emitted a second time by the next file, and a pass at a negative
 * second was already emitted by the previous one. `withinExportedDay` is the
 * one place that rule lives.
 *
 * VINs deliberately stop at `PlateRegistry`. The operational fleet uses them
 * as its own vehicle keys, so resolving a cab or bus to the plate physically
 * fitted to it has to join that internal registry once. Nothing below the
 * resolver stores a VIN, and OCR never queries or matches against a registry.
 */

import { join } from "node:path";
import type { DayContext } from "../engine/index.ts";
import { congestion, LAYER, mix, Rng } from "../shared/index.ts";
import { CITY, KIERSTON_DIR, SIM_DATA_DIR } from "../world/index.ts";
import type { ExternalTrafficDay } from "../traffic/index.ts";

const NONE = 0xffffffff;

/**
 * The home jurisdiction's plate rules, as init's `locale` stage publishes
 * them from the jurisdiction bundle to `sim_data/plate_rules.json`.
 *
 * `state` is the home state's code and `issuer` the agency whose records
 * are home plates; `front` is whether a home plate is also on the front.
 * `visitors` is the mix of states a vehicle in no registry is plated in, each
 * with the serial its stand-in plate is written in — `L` takes the next of
 * three drawn letters, `D` the next of six drawn digits, anything else is
 * copied — and a draw past the last share falls back to the home state.
 */
export interface PlateRules {
  version: number;
  jurisdiction: string;
  state: string;
  issuer: string;
  front: boolean;
  visitors: readonly { jurisdiction: string; share: number; pattern: string }[];
}

export const PLATE_RULES_VERSION = 1;
export const PLATE_RULES_FILE = "plate_rules.json";
const VISITOR_LETTERS = 3;
const VISITOR_DIGITS = 6;

/** Check a parsed plate_rules.json, naming what is wrong with it. */
export function parsePlateRules(value: unknown, source: string): PlateRules {
  const rules = value as Partial<PlateRules> | null;
  const fail = (what: string): never => {
    throw new Error(`${source}: ${what}; regenerate it with \`kierston/.venv/bin/python kierston/init/init_sim.py --only locale\``);
  };
  if (!rules || typeof rules !== "object") fail("not a JSON object");
  if (rules!.version !== PLATE_RULES_VERSION) fail(`version ${rules!.version}, expected ${PLATE_RULES_VERSION}`);
  for (const key of ["jurisdiction", "state", "issuer"] as const) {
    if (typeof rules![key] !== "string" || !rules![key]) fail(`no ${key}`);
  }
  if (typeof rules!.front !== "boolean") fail("no boolean front");
  if (!Array.isArray(rules!.visitors) || rules!.visitors.length === 0) fail("no visitors");
  for (const row of rules!.visitors!) {
    if (typeof row.jurisdiction !== "string" || typeof row.share !== "number" || typeof row.pattern !== "string") {
      fail("a visitors row needs jurisdiction, share and pattern");
    }
    const letters = [...row.pattern].filter((char) => char === "L").length;
    const digits = [...row.pattern].filter((char) => char === "D").length;
    if (letters > VISITOR_LETTERS || digits > VISITOR_DIGITS) {
      fail(`visitors ${row.jurisdiction}: pattern ${row.pattern} needs more than ${VISITOR_LETTERS} L or ${VISITOR_DIGITS} D`);
    }
  }
  return rules as PlateRules;
}

/** Read and check `plate_rules.json`. A built city without one is an error, not a default. */
export async function loadPlateRules(path = join(SIM_DATA_DIR, PLATE_RULES_FILE)): Promise<PlateRules> {
  const file = Bun.file(path);
  if (!await file.exists()) {
    throw new Error(`missing ${path}: the ALPR layer needs the jurisdiction's plate rules; `
      + "publish them with `kierston/.venv/bin/python kierston/init/init_sim.py --only locale`");
  }
  return parsePlateRules(await file.json(), path);
}

export const PLATE_SIDES = ["rear", "front"] as const;
export type PlateSide = typeof PLATE_SIDES[number];

/** Best at night: these cameras have a dedicated IR illuminator. */
export const LIGHTING = ["day", "night_ir", "twilight"] as const;
export type Lighting = typeof LIGHTING[number];

export const ALPR_OUTCOMES = [
  "correct", "misread", "unreadable", "not_captured", "no_plate", "spurious",
] as const;
export type AlprOutcome = typeof ALPR_OUTCOMES[number];

/**
 * Modelled priors, not measurements. Kept public and copied into KDAY so a
 * read cannot outlive the assumptions that generated it.
 *
 * `correct`, `misread`, and `unreadable` are conditional on capture. Night IR
 * is intentionally the strongest state; twilight is weakest because neither
 * ambient exposure nor the illuminator has an uncontested image.
 */
export const ALPR_MODEL = {
  version: 1,
  source: "modelled",
  lighting: {
    day: { capture: 0.990, correct: 0.970, misread: 0.020, unreadable: 0.010 },
    night_ir: { capture: 0.995, correct: 0.985, misread: 0.010, unreadable: 0.005 },
    twilight: { capture: 0.975, correct: 0.930, misread: 0.045, unreadable: 0.025 },
  },
  noPlateSpurious: { day: 0.0015, night_ir: 0.0005, twilight: 0.0030 },
  headway: [
    { belowSeconds: 0.6, capture: 0.90, error: 2.00 },
    { belowSeconds: 1.0, capture: 0.98, error: 1.40 },
    { belowSeconds: 2.0, capture: 0.995, error: 1.10 },
  ],
  dwell: [
    { belowSeconds: 0.4, capture: 0.85, error: 2.50 },
    { belowSeconds: 0.6, capture: 0.96, error: 1.60 },
    { belowSeconds: 0.8, capture: 0.99, error: 1.20 },
  ],
  mutation: {
    substituteOne: 0.82,
    substituteTwo: 0.12,
    transpose: 0.03,
    delete: 0.02,
    insert: 0.01,
  },
} as const;

interface StringPool {
  readonly values: readonly string[];
  id(value: string | null): number;
}

export interface AlprMovement {
  personId: ArrayLike<number>;
  personLegOffset: ArrayLike<number>;
  personLegCount: ArrayLike<number>;
  legDepart: ArrayLike<number>;
  legArrive: ArrayLike<number>;
  legMode: ArrayLike<number>;
  legPurpose: ArrayLike<number>;
  legJourney: ArrayLike<number>;
  legVehicle: ArrayLike<number>;
  legPathOffset: ArrayLike<number>;
  legPathCount: ArrayLike<number>;
  pathLat: ArrayLike<number>;
  pathLon: ArrayLike<number>;
  modes: readonly string[];
  purposes: readonly string[];
}

interface CameraRecord {
  id: string;
  mount: string;
  reads: PlateSide;
  edge: number;
  from_node: number;
  to_node: number;
  role: string;
  owner_kind: string;
  free_flow_mps: number;
  zone_seconds: number | null;
  optics: string;
}

interface CameraFile {
  city: string;
  optics: Record<string, { capture_distance_m: number }>;
  mount_records: { id: string; lat: number; lon: number }[];
  camera_records: CameraRecord[];
}

interface VehicleRecord {
  plate: string;
  plate_type?: string;
  issuer?: string | null;
  jurisdiction?: string | null;
  plate_sides?: PlateSide[];
  owner: number | null;
  owner_type: string;
  household: number | null;
  body?: string | null;
}

interface VehicleFile {
  vehicles: Record<string, VehicleRecord>;
}

export interface PlateTruth {
  text: string;
  jurisdiction: string;
  front: boolean;
  rear: boolean;
  body: string | null;
}

export interface AlprDay {
  model: typeof ALPR_MODEL;
  cameraId: number[];
  cameraEdge: number[];
  cameraSide: number[];
  cameraLat: number[];
  cameraLon: number[];
  cameraRole: number[];
  cameraOwner: number[];
  truthCorrelation: number[];
  truthCamera: number[];
  truthSecond: number[];
  truthLeg: number[];
  truthSource: number[];
  truthMovement: number[];
  truthSide: number[];
  truthPlate: number[];
  truthJurisdiction: number[];
  observationCorrelation: number[];
  observationCamera: number[];
  observationSecond: number[];
  observationDetected: number[];
  observationCanonical: number[];
  observationConfidence: number[];
  observationOutcome: number[];
  observationLighting: number[];
  observationHeadway: number[];
  observationDwell: number[];
  reads: number;
  correct: number;
  misread: number;
  unreadable: number;
  notCaptured: number;
  noPlate: number;
  spurious: number;
}

interface IndexedCamera extends CameraRecord {
  index: number;
  lat: number;
  lon: number;
  captureDistance: number;
}

interface Pass {
  background?: boolean;
  camera: IndexedCamera;
  leg: number;
  occurrence: number;
  /** Fractional simulation second, retained for traffic spacing. */
  at: number;
  /** Whole-second public timestamp written to KDAY. */
  second: number;
  plate: PlateTruth | null;
  dwell: number;
  /** 0 is a resident leg; 1 is an external trip. */
  source: number;
  movement: number;
}

function emptyDay(model = ALPR_MODEL): AlprDay {
  return {
    model,
    cameraId: [], cameraEdge: [], cameraSide: [], cameraLat: [], cameraLon: [],
    cameraRole: [], cameraOwner: [],
    truthCorrelation: [], truthCamera: [], truthSecond: [], truthLeg: [],
    truthSource: [], truthMovement: [], truthSide: [],
    truthPlate: [], truthJurisdiction: [],
    observationCorrelation: [], observationCamera: [], observationSecond: [],
    observationDetected: [], observationCanonical: [], observationConfidence: [],
    observationOutcome: [], observationLighting: [], observationHeadway: [],
    observationDwell: [],
    reads: 0, correct: 0, misread: 0, unreadable: 0, notCaptured: 0,
    noPlate: 0, spurious: 0,
  };
}

function jurisdictionOf(row: VehicleRecord, rules: PlateRules): string {
  if (row.jurisdiction) return row.jurisdiction;
  if (row.issuer === rules.issuer) return rules.state;
  return row.issuer || "unknown";
}

/** Whether a plate from `jurisdiction` is on the front too, absent an explicit rule. */
function frontPlate(jurisdiction: string, rules: PlateRules): boolean {
  return jurisdiction === rules.state ? rules.front : true;
}

/**
 * A home plate follows the home state's front-plate rule. A future transient
 * record can state `plate_sides` exactly; absent that, a non-local record
 * follows the model's stated simplification and presents both sides.
 */
export function plateTruth(row: VehicleRecord, rules: PlateRules): PlateTruth {
  const jurisdiction = jurisdictionOf(row, rules);
  const explicit = row.plate_sides;
  return {
    text: row.plate,
    jurisdiction,
    front: explicit ? explicit.includes("front") : frontPlate(jurisdiction, rules),
    rear: explicit ? explicit.includes("rear") : true,
    body: row.body ?? null,
  };
}

export function plateOnSide(plate: PlateTruth | null, side: PlateSide): string | null {
  if (!plate) return null;
  return plate[side] ? plate.text : null;
}

function randomCharacters(rng: Rng, alphabet: string, count: number): string {
  let out = "";
  for (let index = 0; index < count; index += 1) {
    out += alphabet[rng.int(0, alphabet.length - 1)]!;
  }
  return out;
}

/** Write a visitor serial: `L` and `D` consume the drawn letters and digits in order. */
function fillPattern(pattern: string, letters: string, digits: string): string {
  let letter = 0;
  let digit = 0;
  let out = "";
  for (const char of pattern) {
    if (char === "L") out += letters[letter++]!;
    else if (char === "D") out += digits[digit++]!;
    else out += char;
  }
  return out;
}

/**
 * A stable plate for a vehicle that appears in travel but not in the resident
 * vehicle register. This occurs for a small set of respondents who report
 * driving while their sampled household owns no car: an employer, rental, or
 * borrowed car is still a physical plated vehicle when it crosses a reader.
 *
 * The neighbouring-state mix is explicitly modelled, in the rules' `visitors`.
 * A home plate follows the home front-plate rule; the out-of-state fallbacks
 * present both plates under the same rule as every other non-local vehicle
 * record.
 */
export function externalPlateTruth(seed: number, person: number, rules: PlateRules): PlateTruth {
  const rng = new Rng(mix(seed, person, LAYER.alpr, 0x455854));
  const draw = rng.next();
  let cumulative = 0;
  let visitor = rules.visitors.find((row) => row.jurisdiction === rules.state);
  let jurisdiction = rules.state;
  for (const row of rules.visitors) {
    cumulative += row.share;
    if (draw < cumulative) { jurisdiction = row.jurisdiction; visitor = row; break; }
  }
  const letters = randomCharacters(rng, LETTERS, VISITOR_LETTERS);
  const digits = randomCharacters(rng, DIGITS, VISITOR_DIGITS);
  if (!visitor) throw new Error(`plate rules: the home state ${rules.state} has no visitors row to fall back on`);
  const text = fillPattern(visitor.pattern, letters, digits);
  return { text, jurisdiction, front: frontPlate(jurisdiction, rules), rear: true, body: null };
}

class PlateRegistry {
  private readonly byReference = new Map<string, PlateTruth>();
  private readonly byOwner = new Map<number, PlateTruth[]>();
  private readonly byHousehold = new Map<number, PlateTruth[]>();

  constructor(file: VehicleFile, private readonly rules: PlateRules) {
    for (const [reference, row] of Object.entries(file.vehicles)) {
      const plate = plateTruth(row, rules);
      this.byReference.set(reference, plate);
      if (row.owner_type !== "person") continue;
      if (row.owner !== null) this.add(this.byOwner, row.owner, plate);
      if (row.household !== null) this.add(this.byHousehold, row.household, plate);
    }
    for (const values of this.byOwner.values()) values.sort((a, b) => a.text.localeCompare(b.text));
    for (const values of this.byHousehold.values()) values.sort((a, b) => a.text.localeCompare(b.text));
  }

  private add(index: Map<number, PlateTruth[]>, key: number, plate: PlateTruth): void {
    const values = index.get(key);
    if (values) values.push(plate);
    else index.set(key, [plate]);
  }

  reference(value: string | null | undefined): PlateTruth | null {
    return value ? this.byReference.get(value) ?? null : null;
  }

  personal(person: number, household: number, seed: number, day: number): PlateTruth | null {
    const owned = this.byOwner.get(person);
    const candidates = owned && owned.length > 0 ? owned : this.byHousehold.get(household);
    if (!candidates || candidates.length === 0) return externalPlateTruth(seed, person, this.rules);
    const index = mix(seed, person, day, LAYER.alpr) % candidates.length;
    return candidates[index]!;
  }
}

function canonical(text: string): string {
  return [...text.toUpperCase()].filter((char) => /[A-Z0-9]/.test(char)).join("");
}

const CONFUSIONS: Readonly<Record<string, readonly string[]>> = {
  "0": ["O", "Q", "D"], O: ["0", "Q", "D"], Q: ["0", "O"], D: ["0", "O"],
  "1": ["I"], I: ["1"], "2": ["Z"], Z: ["2"], "5": ["S"], S: ["5"],
  "6": ["G"], G: ["6", "C"], C: ["G"], "8": ["B"], B: ["8"],
};
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";

function substitute(char: string, rng: Rng): string {
  const likely = CONFUSIONS[char];
  if (likely && rng.bool(0.8)) return rng.pick(likely);
  const alphabet = /[0-9]/.test(char) ? DIGITS : LETTERS;
  let replacement = char;
  while (replacement === char) replacement = alphabet[rng.int(0, alphabet.length - 1)]!;
  return replacement;
}

function characterSlots(text: string): number[] {
  const slots: number[] = [];
  for (let i = 0; i < text.length; i += 1) if (/[A-Z0-9]/.test(text[i]!)) slots.push(i);
  return slots;
}

/** One plausible OCR error, preserving plate punctuation except for insertion/deletion. */
export function misreadPlate(actual: string, rng: Rng): string {
  const chars = [...actual.toUpperCase()];
  const slots = characterSlots(chars.join(""));
  if (slots.length === 0) {
    return `${LETTERS[rng.int(0, LETTERS.length - 1)]}${DIGITS[rng.int(0, DIGITS.length - 1)]}`;
  }
  const roll = rng.next();
  if (roll < ALPR_MODEL.mutation.substituteOne) {
    const slot = rng.pick(slots);
    chars[slot] = substitute(chars[slot]!, rng);
  } else if (roll < ALPR_MODEL.mutation.substituteOne + ALPR_MODEL.mutation.substituteTwo) {
    const first = rng.pick(slots);
    let second = first;
    if (slots.length > 1) while (second === first) second = rng.pick(slots);
    chars[first] = substitute(chars[first]!, rng);
    chars[second] = substitute(chars[second]!, rng);
  } else if (roll < 0.97 && slots.length > 1) {
    const pairs = slots.slice(0, -1).map((_, index) => index)
      .filter((index) => chars[slots[index]!] !== chars[slots[index + 1]!]);
    if (pairs.length === 0) {
      const slot = rng.pick(slots);
      chars[slot] = substitute(chars[slot]!, rng);
    } else {
      const leftIndex = rng.pick(pairs);
      const left = slots[leftIndex]!;
      const right = slots[leftIndex + 1]!;
      [chars[left], chars[right]] = [chars[right]!, chars[left]!];
    }
  } else if (roll < 0.99) {
    chars.splice(rng.pick(slots), 1);
  } else {
    const at = rng.pick(slots);
    const source = /[0-9]/.test(chars[at]!) ? DIGITS : LETTERS;
    chars.splice(at, 0, source[rng.int(0, source.length - 1)]!);
  }
  return chars.join("");
}

function spuriousPlate(rng: Rng): string {
  let out = "";
  for (let i = 0; i < 3; i += 1) out += LETTERS[rng.int(0, LETTERS.length - 1)]!;
  out += "-";
  for (let i = 0; i < 4; i += 1) out += DIGITS[rng.int(0, DIGITS.length - 1)]!;
  return out;
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= right.length; column += 1) {
      current[column] = Math.min(
        current[column - 1]! + 1,
        previous[column]! + 1,
        previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]!;
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

function trafficModifiers(headway: number, dwell: number): { capture: number; error: number } {
  let capture = 1;
  let error = 1;
  for (const band of ALPR_MODEL.headway) {
    if (headway < band.belowSeconds) { capture *= band.capture; error *= band.error; break; }
  }
  for (const band of ALPR_MODEL.dwell) {
    if (dwell < band.belowSeconds) { capture *= band.capture; error *= band.error; break; }
  }
  return { capture, error };
}

export interface PlateObservation {
  detected: string | null;
  canonical: string | null;
  confidence: number;
  outcome: AlprOutcome;
}

/** The sensor model for one passage, separated for direct statistical tests. */
export function observePlate(
  actual: string | null,
  lighting: Lighting,
  headway: number,
  dwell: number,
  rng: Rng,
): PlateObservation {
  if (actual === null) {
    if (!rng.bool(ALPR_MODEL.noPlateSpurious[lighting])) {
      return { detected: null, canonical: null, confidence: 0, outcome: "no_plate" };
    }
    const detected = spuriousPlate(rng);
    return {
      detected, canonical: canonical(detected),
      confidence: clamp(rng.gauss(0.45, 0.13), 0.12, 0.78), outcome: "spurious",
    };
  }

  const base = ALPR_MODEL.lighting[lighting];
  const traffic = trafficModifiers(headway, dwell);
  if (!rng.bool(clamp(base.capture * traffic.capture, 0, 0.9999))) {
    return { detected: null, canonical: null, confidence: 0, outcome: "not_captured" };
  }

  let unreadable = base.unreadable * Math.sqrt(traffic.error);
  let misread = base.misread * traffic.error;
  const total = unreadable + misread;
  if (total > 0.95) {
    unreadable *= 0.95 / total;
    misread *= 0.95 / total;
  }
  const roll = rng.next();
  if (roll < unreadable) {
    return { detected: null, canonical: null, confidence: 0, outcome: "unreadable" };
  }
  if (roll < unreadable + misread) {
    const detected = misreadPlate(actual, rng);
    const changes = editDistance(canonical(actual), canonical(detected));
    return {
      detected,
      canonical: canonical(detected),
      confidence: clamp(rng.gauss(changes > 1 ? 0.66 : 0.82, changes > 1 ? 0.12 : 0.10), 0.25, 0.98),
      outcome: "misread",
    };
  }
  return {
    detected: actual, canonical: canonical(actual),
    confidence: clamp(rng.gauss(0.95, 0.035), 0.72, 0.999), outcome: "correct",
  };
}

function dayOfYear(date: Date): number {
  return Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate())
    - Date.UTC(date.getFullYear(), 0, 0)) / 86_400_000);
}

function nthSunday(year: number, month: number, nth: number): number {
  const first = new Date(year, month, 1).getDay();
  return 1 + ((7 - first) % 7) + (nth - 1) * 7;
}

function usDaylightTime(date: Date): boolean {
  const month = date.getMonth();
  if (month > 2 && month < 10) return true;
  if (month < 2 || month > 10) return false;
  const day = date.getDate();
  if (month === 2) return day >= nthSunday(date.getFullYear(), 2, 2);
  return day < nthSunday(date.getFullYear(), 10, 1);
}

/** Approximate solar altitude from the local civil clock, sufficient for light state. */
function solarAltitude(date: Date, second: number, lat: number, lon: number): number {
  const dayOffset = Math.floor(second / 86_400);
  const local = new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset);
  const within = ((second % 86_400) + 86_400) % 86_400;
  const hour = within / 3600;
  const gamma = (2 * Math.PI / 365) * (dayOfYear(local) - 1 + (hour - 12) / 24);
  const equation = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma)
    - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma)
    - 0.040849 * Math.sin(2 * gamma));
  const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
    - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
    - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  // The simulation's current cities are US profiles. Longitude supplies the
  // standard zone; the ordinary US daylight rule moves its civil clock.
  const timezone = Math.round(lon / 15) + (usDaylightTime(local) ? 1 : 0);
  const solarMinutes = hour * 60 + equation + 4 * lon - 60 * timezone;
  const hourAngle = (solarMinutes / 4 - 180) * Math.PI / 180;
  const latitude = lat * Math.PI / 180;
  return Math.asin(
    Math.sin(latitude) * Math.sin(declination)
    + Math.cos(latitude) * Math.cos(declination) * Math.cos(hourAngle),
  ) * 180 / Math.PI;
}

export function lightingAt(date: Date, second: number, lat: number, lon: number): Lighting {
  const altitude = solarAltitude(date, second, lat, lon);
  if (altitude >= 6) return "day";
  if (altitude <= -6) return "night_ir";
  return "twilight";
}

export const DAY_SECONDS = 86_400;

/** Whether a pass at `second` of the exported date belongs to that date's file. */
export function withinExportedDay(second: number): boolean {
  return second >= 0 && second < DAY_SECONDS;
}

export function correlationId(date: string, camera: string, leg: number, occurrence: number): string {
  return `${date}:${camera}:leg-${leg}:crossing-${occurrence}`;
}

function pairKey(aLat: number, aLon: number, bLat: number, bLon: number): string {
  return `${aLat}/${aLon}/${bLat}/${bLon}`;
}

function metres(aLatE6: number, aLonE6: number, bLatE6: number, bLonE6: number): number {
  const toRad = Math.PI / 180e6;
  const dLat = (bLatE6 - aLatE6) * toRad;
  const dLon = (bLonE6 - aLonE6) * toRad;
  const lat1 = aLatE6 * toRad;
  const lat2 = bLatE6 * toRad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6_371_000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function personByLeg(movement: AlprMovement): Int32Array {
  const out = new Int32Array(movement.legMode.length).fill(-1);
  for (let row = 0; row < movement.personId.length; row += 1) {
    const start = movement.personLegOffset[row]!;
    const end = start + movement.personLegCount[row]!;
    for (let leg = start; leg < end; leg += 1) out[leg] = row;
  }
  return out;
}

/**
 * Legs that move a plated vehicle the plate registry can name.
 *
 * "other" is not one. It is JWTRNS 8 (motorcycle), 11 (worked at home) and 12
 * (other method); none is allocated a VIN, and there is no motorcycle plate
 * model, so a camera on such a leg records nothing rather than a car plate
 * from the rider's household.
 */
function physical(mode: string, purpose: string): boolean {
  return mode === "car" || mode === "cab" || mode === "patrol" || mode === "ambulance"
    || (mode === "bus" && purpose === "run");
}

function plateForLeg(
  context: DayContext,
  registry: PlateRegistry,
  person: number,
  day: number,
  mode: string,
  journey: string | null,
  vehicle: string | null,
): PlateTruth | null {
  if (vehicle) return registry.reference(vehicle);
  if (mode === "cab") {
    return registry.reference(context.fleet?.cabs.find((cab) => cab.person === person)?.vin);
  }
  if (mode === "bus") {
    const runs = context.world.school.driving.get(person) ?? [];
    const run = journey ? runs.find((candidate) => journey.includes(`/${candidate.id}/`)) : null;
    return registry.reference(run?.vin);
  }
  // The household fallback is for a private car leg the allocator did not
  // stamp, such as a scenario replay's. A patrol or ambulance leg without a
  // VIN is the crew member who is not driving; the driver's leg carries the
  // unit's VIN and its passes.
  if (mode !== "car") return null;
  const household = context.world.persons.get(person)?.household;
  return household === undefined ? null
    : registry.personal(person, household, context.world.seed, day);
}

function camerasOf(file: CameraFile, context: DayContext): IndexedCamera[] {
  const mounts = new Map(file.mount_records.map((mount) => [mount.id, mount]));
  return file.camera_records.map((camera, index) => {
    const mount = mounts.get(camera.mount);
    const optics = file.optics[camera.optics];
    const from = camera.from_node;
    return {
      ...camera,
      index,
      lat: mount?.lat ?? context.roads.graph.lat[from] ?? 0,
      lon: mount?.lon ?? context.roads.graph.lon[from] ?? 0,
      captureDistance: optics?.capture_distance_m ?? Math.max(1, (camera.zone_seconds ?? 1) * camera.free_flow_mps),
    };
  });
}

function indexCameras(cameras: readonly IndexedCamera[], context: DayContext): Map<string, IndexedCamera[]> {
  const index = new Map<string, IndexedCamera[]>();
  const graph = context.roads.graph;
  for (const camera of cameras) {
    const key = pairKey(
      Math.round(graph.lat[camera.from_node]! * 1e6),
      Math.round(graph.lon[camera.from_node]! * 1e6),
      Math.round(graph.lat[camera.to_node]! * 1e6),
      Math.round(graph.lon[camera.to_node]! * 1e6),
    );
    const held = index.get(key);
    if (held) held.push(camera);
    else index.set(key, [camera]);
  }
  return index;
}

function collectPasses(
  context: DayContext,
  registry: PlateRegistry,
  cameras: readonly IndexedCamera[],
  movement: AlprMovement,
  strings: StringPool,
  day: number,
): Pass[] {
  const cameraByPair = indexCameras(cameras, context);
  const people = personByLeg(movement);
  const passes: Pass[] = [];
  for (let leg = 0; leg < movement.legMode.length; leg += 1) {
    const mode = movement.modes[movement.legMode[leg]!] ?? "";
    const purpose = movement.purposes[movement.legPurpose[leg]!] ?? "";
    if (!physical(mode, purpose)) continue;
    const personRow = people[leg]!;
    if (personRow < 0) continue;
    const person = movement.personId[personRow]!;
    const journeyId = movement.legJourney[leg]!;
    const journey = journeyId === NONE ? null : strings.values[journeyId] ?? null;
    const vehicleId = movement.legVehicle[leg]!;
    const vehicle = vehicleId === NONE ? null : strings.values[vehicleId] ?? null;
    const plate = plateForLeg(context, registry, person, day, mode, journey, vehicle);
    // No plate the registry can name, no pass: a pass with a null plate would
    // be a vehicle the vehicle table does not show moving.
    if (!plate) continue;
    const start = movement.legPathOffset[leg]!;
    const count = movement.legPathCount[leg]!;
    if (count < 2) continue;

    const hits: { camera: IndexedCamera; atMetres: number; occurrence: number }[] = [];
    const occurrences = new Map<number, number>();
    let distance = 0;
    for (let i = 0; i < count - 1; i += 1) {
      const at = start + i;
      const aLat = movement.pathLat[at]!;
      const aLon = movement.pathLon[at]!;
      const bLat = movement.pathLat[at + 1]!;
      const bLon = movement.pathLon[at + 1]!;
      const segment = metres(aLat, aLon, bLat, bLon);
      const found = cameraByPair.get(pairKey(aLat, aLon, bLat, bLon));
      if (found) {
        for (const camera of found) {
          const occurrence = occurrences.get(camera.index) ?? 0;
          occurrences.set(camera.index, occurrence + 1);
          hits.push({ camera, atMetres: distance + segment / 2, occurrence });
        }
      }
      distance += segment;
    }
    if (hits.length === 0) continue;

    const depart = movement.legDepart[leg]! * 60;
    const arrive = Math.max(depart, movement.legArrive[leg]! * 60);
    for (const hit of hits) {
      const fraction = distance > 0 ? hit.atMetres / distance : 0.5;
      const at = depart + (arrive - depart) * fraction;
      const second = Math.round(at);
      const dwell = (hit.camera.zone_seconds
        ?? hit.camera.captureDistance / Math.max(1, hit.camera.free_flow_mps))
        * congestion(at / 60);
      passes.push({
        camera: hit.camera, leg, occurrence: hit.occurrence, at, second, plate, dwell,
        source: 0, movement: leg,
      });
    }
  }
  return passes;
}

function collectExternalPasses(
  context: DayContext,
  cameras: readonly IndexedCamera[],
  traffic: ExternalTrafficDay,
): Pass[] {
  const cameraByPair = indexCameras(cameras, context);
  const passes: Pass[] = [];
  for (let trip = 0; trip < traffic.tripVehicle.length; trip += 1) {
    const vehicle = traffic.vehicles[traffic.tripVehicle[trip]!]!;
    const plate: PlateTruth = {
      text: vehicle.plate, jurisdiction: vehicle.state,
      front: vehicle.plate_sides.includes("front"), rear: vehicle.plate_sides.includes("rear"),
      body: vehicle.body,
    };
    const route = traffic.tripRoute[trip]!;
    const start = traffic.routePathOffset[route]!;
    const count = traffic.routePathCount[route]!;
    if (count < 2) continue;
    const hits: { camera: IndexedCamera; atMetres: number; occurrence: number }[] = [];
    const occurrences = new Map<number, number>();
    let distance = 0;
    for (let i = 0; i < count - 1; i += 1) {
      const at = start + i;
      const aLat = traffic.pathLat[at]!;
      const aLon = traffic.pathLon[at]!;
      const bLat = traffic.pathLat[at + 1]!;
      const bLon = traffic.pathLon[at + 1]!;
      const segment = metres(aLat, aLon, bLat, bLon);
      const found = cameraByPair.get(pairKey(aLat, aLon, bLat, bLon));
      if (found) {
        for (const camera of found) {
          const occurrence = occurrences.get(camera.index) ?? 0;
          occurrences.set(camera.index, occurrence + 1);
          hits.push({ camera, atMetres: distance + segment / 2, occurrence });
        }
      }
      distance += segment;
    }
    const depart = traffic.tripDepartSecond[trip]!;
    const arrive = Math.max(depart, traffic.tripArriveSecond[trip]!);
    for (const hit of hits) {
      const fraction = distance > 0 ? hit.atMetres / distance : 0.5;
      const at = depart + (arrive - depart) * fraction;
      const dwell = (hit.camera.zone_seconds
        ?? hit.camera.captureDistance / Math.max(1, hit.camera.free_flow_mps))
        * congestion(at / 60);
      passes.push({
        camera: hit.camera, leg: NONE, occurrence: hit.occurrence,
        at, second: Math.round(at), plate, dwell, source: 1, movement: trip,
      });
    }
  }
  return passes;
}

function microdegrees(value: number): number {
  return Math.round(value * 1e6);
}

/**
 * Build the truth and observation tables for one exported day.
 *
 * The file reads are optional by design: a city with no sited fleet writes an
 * honest `surveilled: 0` day rather than failing an otherwise valid export.
 */
export async function simulateAlpr(
  context: DayContext,
  date: Date,
  day: number,
  movement: AlprMovement,
  traffic: ExternalTrafficDay,
  strings: StringPool,
  cameraPath = join(KIERSTON_DIR, "cities", CITY, "cameras.json"),
  vehiclePath = join(SIM_DATA_DIR, "vehicles.json"),
  replay?: {
    background: readonly { camera: string; second: number }[];
    identityPrefix: string;
  },
  rulesPath = join(SIM_DATA_DIR, PLATE_RULES_FILE),
): Promise<AlprDay> {
  const out = emptyDay();
  const cameraAsset = Bun.file(cameraPath);
  const vehicleAsset = Bun.file(vehiclePath);
  if (!await cameraAsset.exists() || !await vehicleAsset.exists()) return out;

  // Past the check above, a sited fleet and a registry exist, so a missing
  // rule file is a stale build rather than a city without cameras.
  const [cameraFile, vehicleFile, rules] = await Promise.all([
    cameraAsset.json() as Promise<CameraFile>,
    vehicleAsset.json() as Promise<VehicleFile>,
    loadPlateRules(rulesPath),
  ]);
  const cameras = camerasOf(cameraFile, context);
  const registry = new PlateRegistry(vehicleFile, rules);
  for (const camera of cameras) {
    out.cameraId.push(strings.id(camera.id));
    out.cameraEdge.push(camera.edge);
    out.cameraSide.push(PLATE_SIDES.indexOf(camera.reads));
    out.cameraLat.push(microdegrees(camera.lat));
    out.cameraLon.push(microdegrees(camera.lon));
    out.cameraRole.push(strings.id(camera.role));
    out.cameraOwner.push(strings.id(camera.owner_kind));
  }

  const byId = new Map(cameras.map((camera) => [camera.id, camera]));
  const background: Pass[] = (replay?.background ?? []).map((row, index) => {
    const camera = byId.get(row.camera);
    if (!camera) throw new Error(`baseline ALPR camera ${row.camera} is absent from the current fleet`);
    return { camera, leg: -1, occurrence: 0, at: row.second, second: row.second,
      plate: null, dwell: 0, source: 2, movement: index, background: true };
  });
  const passes = [
    ...collectPasses(context, registry, cameras, movement, strings, day),
    ...collectExternalPasses(context, cameras, traffic),
    ...background,
  ].sort((a, b) => a.camera.index - b.camera.index
    || a.at - b.at || a.source - b.source || a.movement - b.movement || a.occurrence - b.occurrence);
  const dateText = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  for (let index = 0; index < passes.length; index += 1) {
    const pass = passes[index]!;
    const previous = index > 0 && passes[index - 1]!.camera.index === pass.camera.index
      ? pass.at - passes[index - 1]!.at : Infinity;
    const next = index + 1 < passes.length && passes[index + 1]!.camera.index === pass.camera.index
      ? passes[index + 1]!.at - pass.at : Infinity;
    const headway = Math.max(0, Math.min(previous, next));
    if (pass.background) continue;
    // Headway is measured against the neighbouring passes above before this
    // test, so a car that crossed just before midnight still crowds the first
    // read of the new day.
    if (!withinExportedDay(pass.second)) continue;
    const actual = plateOnSide(pass.plate, pass.camera.reads);
    const lighting = lightingAt(date, pass.second, pass.camera.lat, pass.camera.lon);
    const originalId = pass.source === 0
      ? correlationId(dateText.replaceAll("-", ""), pass.camera.id, pass.movement, pass.occurrence)
      : `${dateText.replaceAll("-", "")}:${pass.camera.id}:external-${pass.movement}:crossing-${pass.occurrence}`;
    const id = replay ? `${replay.identityPrefix}:${originalId}` : originalId;
    const rng = new Rng(mix(
      context.world.seed, day, pass.camera.index, pass.source, pass.movement, pass.occurrence, LAYER.alpr,
    ));
    const observed = observePlate(actual, lighting, headway, pass.dwell, rng);
    const correlation = strings.id(id);

    out.truthCorrelation.push(correlation);
    out.truthCamera.push(pass.camera.index);
    out.truthSecond.push(pass.second);
    out.truthLeg.push(pass.leg);
    out.truthSource.push(pass.source);
    out.truthMovement.push(pass.movement);
    out.truthSide.push(PLATE_SIDES.indexOf(pass.camera.reads));
    out.truthPlate.push(strings.id(actual));
    out.truthJurisdiction.push(strings.id(actual === null ? null : pass.plate?.jurisdiction ?? null));

    out.observationCorrelation.push(correlation);
    out.observationCamera.push(pass.camera.index);
    out.observationSecond.push(pass.second);
    out.observationDetected.push(strings.id(observed.detected));
    out.observationCanonical.push(strings.id(observed.canonical));
    out.observationConfidence.push(observed.confidence);
    out.observationOutcome.push(ALPR_OUTCOMES.indexOf(observed.outcome));
    out.observationLighting.push(LIGHTING.indexOf(lighting));
    out.observationHeadway.push(Number.isFinite(headway) ? headway : Number.POSITIVE_INFINITY);
    out.observationDwell.push(pass.dwell);

    if (observed.detected !== null) out.reads += 1;
    if (observed.outcome === "correct") out.correct += 1;
    else if (observed.outcome === "misread") out.misread += 1;
    else if (observed.outcome === "unreadable") out.unreadable += 1;
    else if (observed.outcome === "not_captured") out.notCaptured += 1;
    else if (observed.outcome === "no_plate") out.noPlate += 1;
    else out.spurious += 1;
  }
  return out;
}
