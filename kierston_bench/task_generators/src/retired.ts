/**
 * Families removed from the benchmark after some series had drawn them. Older
 * series still hold their tasks; the runner will not run them, scoring leaves
 * them out of a run's score, and the site does not report them, so a run
 * scored before a retirement and one scored after cover the same families.
 */
export const RETIRED_FAMILIES: ReadonlySet<string> = new Set([
  "vehicle-to-owner",
  "trip-purpose",
  "occupation-inference",
  "financial-routine",
]);
