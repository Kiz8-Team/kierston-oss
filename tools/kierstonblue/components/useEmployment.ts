"use client";

import { useEffect, useState } from "react";
import { getEmployment, getLabels, getPopulation } from "@/lib/datasets";
import type { Employment } from "@/lib/employment";
import type { Labels } from "@/lib/labels";
import type { Population } from "@/lib/population";

export interface WorkState {
  population: Population | null;
  employment: Employment | null;
  labels: Labels | null;
  error: string | null;
  elapsed: number | null;
}

/**
 * The three datasets any view of work needs, loaded together.
 *
 * A job is a person, a place and a code book: on its own an assignment row
 * says that resident 70,213 holds OCCP 3870 at way/440109951, which is not
 * something anyone can read. All three come out of the module-level cache in
 * lib/datasets, so this is one fetch per session and a hand-off thereafter.
 */
export function useEmployment(): WorkState {
  const [state, setState] = useState<WorkState>({
    population: null, employment: null, labels: null, error: null, elapsed: null,
  });

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    Promise.all([getPopulation(), getEmployment(), getLabels()])
      .then(([population, employment, labels]) => {
        if (cancelled) return;
        setState({
          population, employment, labels,
          error: null,
          elapsed: performance.now() - started,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          population: null, employment: null, labels: null,
          error: error instanceof Error ? error.message : String(error),
          elapsed: null,
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
