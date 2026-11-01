import { access } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { REPO_ROOT, currentCity, type City } from "./city";

export { REPO_ROOT };

/**
 * Where the simulation lives, relative to this app.
 *
 * KierstonBlue is a viewer, not an owner of data: every dataset stays in
 * kierston/ where the generators write it, and is streamed from there. Nothing
 * is copied into public/, so regenerating a dataset is visible on reload.
 *
 * Dataset roots, keyed by the prefix a request uses, for the city build the
 * request is for (see city.ts). `sources` is what the user downloaded for that
 * city and `reference` is what ships with the engine; both are read-only
 * inputs. Everything the pipeline generates, intake included, is under `sim`,
 * and the days it simulates under `outputs`. `city` is checked-in assets
 * derived from a city once and frozen, beside its `cities/<slug>.toml`.
 */
export type Roots = {
  sources: string;
  reference: string;
  sim: string;
  outputs: string;
  city: string;
};

export type RootName = keyof Roots;

export function rootsOf(city: City): Roots {
  return {
    sources: join(REPO_ROOT, "kierston", "sources", city.slug),
    reference: join(REPO_ROOT, "kierston", "reference"),
    sim: city.dir,
    outputs: city.outputs,
    city: join(REPO_ROOT, "kierston", "cities", city.slug),
  };
}

export async function roots(): Promise<Roots> {
  return rootsOf(await currentCity());
}

export const DATASETS = {
  topology: { root: "sources", file: "topology.graphml" },
  pois: { root: "sim", file: "pois.json" },
  buildings: { root: "sim", file: "buildings.json" },
  // Every packed init output in one container, from init/pack_init.py. The
  // sections below it are copied in whole and still exist as their own files,
  // so this is an alternative way in rather than a replacement — see
  // lib/container.ts, and pack_init.py for why it nests rather than merges.
  sim_init: { root: "sim", file: "sim_init.bin" },
  population: { root: "sim", file: "population.bin" },
  dwellings: { root: "sim", file: "dwellings.json" },
  employment: { root: "sim", file: "employment.json" },
  workplaces: { root: "sim", file: "workplaces.json" },
  enrollment: { root: "sim", file: "enrollment.json" },
  schools: { root: "sim", file: "schools.json" },
  // How each student travels and the bus runs that carry them, from
  // init/education/school_travel.py. 4 MB, and only the bus explorer reads it.
  school_travel: { root: "sim", file: "school_travel.json" },
  fleet: { root: "sim", file: "fleet.json" },
  // The cab stands and who waits at them, from `bun run day --export-taxi` in
  // kierston/sim. 42 KB, and the only file in here written by the simulation
  // rather than by an init stage — the clustering it holds is seeded, so it
  // cannot be re-derived on this side. See sim/src/transport/taxi.ts.
  taxi: { root: "sim", file: "taxi.json" },
  // The cell network, from init/network/towers.py. The structures are read out
  // of the FCC's registration dump; everything transmitting from them —
  // sectors, bands, identifiers, indicative ranges — is modelled.
  towers: { root: "sim", file: "towers.json" },
  // Who is whose parent, from init/social/kinship.py. Left as JSON rather than
  // packed: it is 9 MB, most of which is the parent map, and only the record
  // page reads it.
  kinship: { root: "sim", file: "kinship.json" },
  // The social graph, from init/social/ties.py. Packed rather than JSON: it is
  // 3.3 million edges, and the same edges as JSON would be most of a gigabyte.
  ties: { root: "sim", file: "ties.bin" },
  // The personal records, packed by init/personal_records/pack_records.py.
  // Six files rather than one so a page loads the records it browses and not
  // the other 300 MB — see that script's header for where the cuts fall.
  identity: { root: "sim", file: "identity.bin" },
  criminal: { root: "sim", file: "criminal.bin" },
  civil: { root: "sim", file: "civil.bin" },
  firearms: { root: "sim", file: "firearms.bin" },
  vehicles: { root: "sim", file: "vehicles.bin" },
  holdings: { root: "sim", file: "holdings.bin" },
  // The plate readers, from init/surveillance/cameras.py.
  cameras: { root: "city", file: "cameras.json" },
  occupations: { root: "reference", file: "occp_mapping.json" },
  codebook: { root: "sources", file: "pums_codebook.json" },
} as const;

export async function datasetPath(name: keyof typeof DATASETS): Promise<string> {
  const spec = DATASETS[name];
  return join((await roots())[spec.root as RootName], spec.file);
}

/**
 * Resolve a request path under one of the dataset roots.
 *
 * Returns null for an unknown root or for anything that climbs out of it —
 * the app serves from a directory of the repository, not from the filesystem.
 */
export async function resolveDataset(segments: string[]): Promise<string | null> {
  const [root, ...rest] = segments;
  const all = await roots();
  if (!root || !(root in all) || !rest.length) return null;
  const base = all[root as RootName];
  const target = resolve(join(base, ...rest.map(decodeURIComponent)));
  if (target !== base && !target.startsWith(base + sep)) return null;
  return target;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
