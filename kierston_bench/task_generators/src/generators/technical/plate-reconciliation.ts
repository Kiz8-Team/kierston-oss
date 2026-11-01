/**
 * "Which registered vehicle produced these noisy ALPR observations?"
 *
 * The target is a resident vehicle with at least two camera reads of which
 * at least one is noisy — a misread, or a read the sensor was unsure of.
 * The evidence is the observation table exactly as a camera operator would
 * hold it: detected text, confidence, lighting. The observation row's
 * `outcome` — the simulator's verdict of correct/misread/unreadable — is
 * truth, not instrumentation an operator holds, and is withheld. The answer
 * is the canonical plate, which the truth side of the ALPR tables records
 * per pass.
 */

import type { TaskGenerator } from "../../generator.ts";
import { taskId } from "../../generator.ts";
import { clockSeconds } from "../../format.ts";
import { plateReconciliationEvidence } from "../../plate-evidence.ts";
import type { Rng } from "../../rng.ts";

export const plateReconciliation: TaskGenerator = {
  family: "plate-reconciliation",

  async generate(ctx, rng: Rng, seed) {
    const truth = await ctx.day.columns(
      "alprTruth.correlationId", "alprTruth.plate", "alprTruth.source",
    );
    const obs = await ctx.day.columns(
      "alprObservation.correlationId", "alprObservation.camera", "alprObservation.second",
      "alprObservation.detectedText", "alprObservation.confidence", "alprObservation.lighting",
    );
    const lighting = ctx.day.enumValues("lighting");
    const sources = ctx.day.enumValues("alprMovementSource");

    // Group observation rows by the canonical plate of the pass they came
    // from, resident movements only, keeping only rows a camera produced text
    // for. The correlation id is instrumentation shared by the two tables.
    const plateOfCorrelation = new Map<number, number>();
    for (let i = 0; i < truth.correlationId.length; i += 1) {
      if (sources[truth.source[i]!] !== "resident") continue;
      plateOfCorrelation.set(truth.correlationId[i]!, truth.plate[i]!);
    }
    const byPlate = new Map<number, number[]>();
    for (let i = 0; i < obs.correlationId.length; i += 1) {
      const plate = plateOfCorrelation.get(obs.correlationId[i]!);
      if (plate === undefined) continue;
      const detected = ctx.day.string(obs.detectedText[i]!);
      if (detected === null) continue;
      const rows = byPlate.get(plate);
      if (rows) rows.push(i);
      else byPlate.set(plate, [i]);
    }

    const plates = [...byPlate.keys()].sort((a, b) => a - b);
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const plateString = rng.pick(plates);
      const rows = byPlate.get(plateString)!;
      if (rows.length < 2) continue;
      const canonical = ctx.day.string(plateString)!;
      const noisy = rows.some((row) => ctx.day.string(obs.detectedText[row]!) !== canonical);
      if (!noisy) continue;

      const observations = rows.map((row) => ({
        camera: obs.camera[row]!,
        time: clockSeconds(obs.second[row]!),
        detectedText: ctx.day.string(obs.detectedText[row]!),
        confidence: Number(obs.confidence[row]!.toFixed(3)),
        lighting: lighting[obs.lighting[row]!],
      }));

      return {
        id: taskId(this.family, ctx.date, seed),
        family: this.family,
        date: ctx.date,
        seed,
        ...plateReconciliationEvidence(ctx.date, observations),
        answer: {
          kind: "ranked-ids",
          description: "Canonical plate strings, most likely first.",
        },
        groundTruth: { plate: canonical },
        scoring: {
          method: "rank",
          aggregate: "top-1 accuracy and recall@5; optionally edit-distance-weighted top-1",
        },
      };
    }
    throw new Error("no noisy multi-read plate found; the day may not support this family");
  },
};
