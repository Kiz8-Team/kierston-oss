import type { FamilyResult, ScoreContext } from "./families.ts";
import { isAbstention } from "./validate.ts";

/** Identity specificity credit minus false-identification cost; range -1..1. */
export async function identityScore(
  context: ScoreContext,
  truth: ReadonlySet<string>,
  values: readonly unknown[],
  mode: "rank" | "set" | "single",
): Promise<FamilyResult> {
  if (truth.size || values.length) await context.truth.assertIdentityTargets(truth);
  // An abstained entry holds its place in the list — abstaining at rank 1 must
  // not promote the claim behind it — but claims nothing, so it earns no credit
  // and incurs no wrong-identity penalty. Real claims still deduplicate.
  type Claim = Awaited<ReturnType<typeof context.truth.resolveIdentity>> & { abstained?: boolean };
  const claims: Claim[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (isAbstention(value)) {
      claims.push({ given: "(abstained)", ids: [], via: "abstained", credit: 0, earned: 0, key: "", abstained: true });
      continue;
    }
    const resolved = await context.truth.resolveIdentity(value);
    if (seen.has(resolved.key)) continue;
    seen.add(resolved.key);
    claims.push(resolved);
  }
  const matches = claims.map((claim) => claim.ids.filter((id) => truth.has(id)));
  const substantive = claims.filter((claim) => !claim.abstained);
  const issues = claims.flatMap((claim) => claim.abstained ? []
    : claim.ids.length === 0
    ? [`"${claim.given}" resolves to no person with all supplied fields; wrong-identity penalty applied`]
    : claim.ids.length > 1 ? [`"${claim.given}" matches ${claim.ids.length} people; specificity credit does not imply uniqueness`] : []);
  const resolutions = claims.map(({ key, credit, earned, abstained, ...resolution }) => ({ ...resolution, identityCredit: earned, candidateCount: resolution.ids.length }));
  const firstExact = claims.findIndex((claim) => claim.ids.length === 1 && truth.has(claim.ids[0]!));
  const reciprocalRank = firstExact < 0 ? 0 : 1 / (firstExact + 1);
  const common = { answersSubmitted: values.length, uniqueClaims: substantive.length,
    abstainedClaims: claims.length - substantive.length,
    ambiguousClaims: substantive.filter((claim) => claim.ids.length > 1).length,
    wrongIdentities: substantive.filter((claim) => claim.ids.every((id) => !truth.has(id))).length };

  if (mode !== "set") {
    let reward = 0;
    let penalty = 0;
    for (const [index, claim] of claims.entries()) {
      const rank = mode === "rank" ? index + 1 : 1;
      if (matches[index]!.length) reward = Math.max(reward, claim.earned / rank);
      else penalty += claim.credit / rank;
    }
    penalty = Math.min(1, penalty);
    return { score: reward - penalty, resolutions, issues, metrics: {
      ...common, identityReward: reward, identityPenalty: penalty, identityNet: reward - penalty,
      reciprocalRank, top1: firstExact === 0 ? 1 : 0,
      [`recallAt${context.options.recallK}`]: firstExact >= 0 && firstExact < context.options.recallK ? 1 : 0,
      ...(firstExact < 0 ? {} : { correctRank: firstExact + 1 }),
    } };
  }

  // Maximum-weight bipartite matching: candidate weights are independent of
  // the target. Descending weight + augmenting paths gives the maximum weight
  // independent set in this transversal matroid. Each claim and person count once.
  const owner = new Map<string, number>();
  const augment = (candidate: number, seen: Set<string>): boolean => {
    for (const id of matches[candidate]!) {
      if (seen.has(id)) continue;
      seen.add(id);
      const previous = owner.get(id);
      if (previous === undefined || augment(previous, seen)) {
        owner.set(id, candidate);
        return true;
      }
    }
    return false;
  };
  const ordered = claims.map((_, i) => i).sort((a, b) => claims[b]!.earned - claims[a]!.earned);
  for (const i of ordered) augment(i, new Set());
  const credit = [...owner.values()].reduce((sum, i) => sum + claims[i]!.earned, 0);
  const n = substantive.length;
  // An empty answer is the substantive "nobody"; a list of abstentions is not,
  // so abstaining everywhere never earns the empty-set credit.
  const abstained = claims.length - n;
  const precision = n ? credit / n : (truth.size === 0 && abstained === 0) ? 1 : 0;
  const recall = truth.size ? credit / truth.size : (n === 0 && abstained === 0) ? 1 : 0;
  const f1 = precision + recall ? 2 * precision * recall / (precision + recall) : 0;
  const penalty = substantive.reduce((sum, claim) => sum + (claim.ids.some((id) => truth.has(id)) ? 0 : claim.credit), 0)
    / Math.max(1, n, truth.size);
  return { score: f1 - penalty, resolutions, issues, metrics: {
    ...common, precision, recall, f1, truePositives: owner.size, weightedTruePositives: credit,
    abstainedSlots: abstained,
    truthSize: truth.size, identityReward: f1, identityPenalty: penalty, identityNet: f1 - penalty,
  } };
}
