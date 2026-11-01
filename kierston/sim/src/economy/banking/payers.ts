/**
 * Who money arrives from, when it is not a person in the city.
 *
 * `doTransferIn` takes a sender's name, and most callers will not have one to
 * hand: a stream says somebody is paid fortnightly by site `way/440109951`,
 * not that the payer prints "CITY PAYROLL" on the ACH descriptor.
 * This is the stand-in directory, keyed on the INDP sector prefix the init
 * stage already uses everywhere else.
 *
 * These are placeholders and are meant to be replaced. When the LLC layer
 * lands, a transfer's sender becomes a real registered entity with an address
 * and a filing history, and this file becomes the fallback for the ones that
 * never got incorporated. The names are deliberately generic for that reason —
 * nothing downstream should be keying on them.
 */

import { mix, Rng } from "../../shared/index.ts";
import { readCityTable } from "../../world/index.ts";

/**
 * The directory itself is the city's `payers.csv`: `sector,name` rows, where
 * the sector is an INDP prefix, `benefit:<source>` names the payer of a
 * non-wage stream, and `fallback` covers a sector with no row. Rows keep file
 * order, which the draw in `payerFor` depends on.
 */
interface Directory {
  bySector: Map<string, string[]>;
  benefits: Map<string, string>;
  fallback: string[];
}

let directory: Directory | null = null;

function payers(): Directory {
  if (directory) return directory;
  const bySector = new Map<string, string[]>();
  const benefits = new Map<string, string>();
  const fallback: string[] = [];
  for (const { sector, name } of readCityTable("payers.csv")) {
    if (!sector || !name) throw new Error("payers.csv: every row needs a sector and a name");
    if (sector === "fallback") fallback.push(name);
    else if (sector.startsWith("benefit:")) benefits.set(sector.slice("benefit:".length), name);
    else {
      const names = bySector.get(sector);
      if (names) names.push(name);
      else bySector.set(sector, [name]);
    }
  }
  if (fallback.length === 0) throw new Error("payers.csv: no fallback payer");
  directory = { bySector, benefits, fallback };
  return directory;
}

/**
 * A stand-in payer for a sector, stable for a given key.
 *
 * `key` is whatever identifies the payer to the caller — a site id, usually —
 * so the same employer sends money under the same name every fortnight
 * instead of picking a new one each payday.
 */
export function payerFor(sector: string | null, key: string): string {
  const { bySector, fallback } = payers();
  const names = (sector && bySector.get(sector)) || fallback;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (Math.imul(hash, 31) + key.charCodeAt(i)) | 0;
  }
  return names[new Rng(mix(hash)).int(0, names.length - 1)]!;
}

/** The payer behind a non-wage income stream, which is never a company. */
export function benefitPayer(source: string): string | null {
  return payers().benefits.get(source) ?? null;
}
