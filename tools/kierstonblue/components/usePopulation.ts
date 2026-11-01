"use client";

import { useEffect, useState } from "react";
import { getPopulation } from "@/lib/datasets";
import type { Population } from "@/lib/population";

export interface PopulationState {
  population: Population | null;
  error: string | null;
  elapsed: number | null;
}

/**
 * The packed population, loaded once per session.
 *
 * Every page that needs people shares the module-level cache in lib/datasets,
 * so this is a fetch on the first page that asks and a synchronous hand-off on
 * the rest.
 */
export function usePopulation(): PopulationState {
  const [state, setState] = useState<PopulationState>({
    population: null, error: null, elapsed: null,
  });

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    getPopulation()
      .then((population) => {
        if (cancelled) return;
        setState({ population, error: null, elapsed: performance.now() - started });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          population: null,
          error: error instanceof Error ? error.message : String(error),
          elapsed: null,
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
