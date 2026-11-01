"use client";

import { useEffect, useState } from "react";
import { getEnrollment, getLabels, getPopulation } from "@/lib/datasets";
import type { Enrollment } from "@/lib/enrollment";
import type { Labels } from "@/lib/labels";
import type { Population } from "@/lib/population";

export interface SchoolState {
  population: Population | null;
  enrollment: Enrollment | null;
  labels: Labels | null;
  error: string | null;
  elapsed: number | null;
}

/**
 * The three datasets any view of school needs, loaded together.
 *
 * The mirror of useEmployment, and for the same reason: on its own an
 * enrollment row says that resident 4 is in SCHG 12 at way/1534829335, which
 * needs the population to become a person, the catalogue to become a place and
 * the code book to become a grade. All three come from the module-level cache
 * in lib/datasets, so a reader moving between the students table, the schools
 * table and the map pays for them once.
 */
export function useEnrollment(): SchoolState {
  const [state, setState] = useState<SchoolState>({
    population: null, enrollment: null, labels: null, error: null, elapsed: null,
  });

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    Promise.all([getPopulation(), getEnrollment(), getLabels()])
      .then(([population, enrollment, labels]) => {
        if (cancelled) return;
        setState({
          population, enrollment, labels,
          error: null,
          elapsed: performance.now() - started,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          population: null, enrollment: null, labels: null,
          error: error instanceof Error ? error.message : String(error),
          elapsed: null,
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
