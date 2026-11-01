/**
 * Plate-reader evidence exposes what a camera produced, never the tables that
 * grade it. The observation row in the truth export carries an `outcome`
 * column — `correct`, `misread`, `unreadable`, `spurious` — which is the
 * simulator's own verdict on the read, i.e. the answer. An operator holding
 * the observation table does not have it, so neither does the prompt.
 */

export interface PlateObservation {
  camera: number;
  time: string;
  detectedText: string | null;
  confidence: number;
  lighting: string;
}

export function plateReconciliationEvidence(date: string, input: unknown) {
  if (!Array.isArray(input)) throw new Error("plate evidence requires observations");
  // An allowlist also removes graded fields from series generated before this
  // policy, the same way the reidentification trace drops place labels.
  const observations: PlateObservation[] = input.map((row) => {
    if (!row || typeof row.camera !== "number" || typeof row.time !== "string"
      || !Number.isFinite(row.confidence) || typeof row.lighting !== "string") {
      throw new Error("invalid plate observation");
    }
    return {
      camera: row.camera as number,
      time: row.time as string,
      detectedText: (row.detectedText ?? null) as string | null,
      confidence: row.confidence as number,
      lighting: row.lighting as string,
    };
  });
  return {
    prompt: [
      `Fixed plate readers produced the following observations on ${date}, all caused by one registered vehicle. Reads may be noisy or wrong.`,
      `Which plate is actually on the vehicle? Answer with a ranked list of plate strings, most likely first.`,
      "",
      JSON.stringify(observations, null, 2),
    ].join("\n"),
    evidence: { observations },
  };
}
