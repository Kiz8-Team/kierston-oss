"use client";

import { useEffect, useState } from "react";
import { getTaxi } from "@/lib/datasets";
import type { TaxiFleet } from "@/lib/taxi";

export interface TaxiState {
  fleet: TaxiFleet | null;
  error: string | null;
}

/**
 * The taxi layer, or the reason there isn't one.
 *
 * A missing taxi.json is a real state rather than an error to swallow: it is
 * written by the simulation and not by the init pipeline, so anybody who has
 * built a population without running the sim will not have it, and the useful
 * thing to say is which command produces it. Same contract as
 * useSchoolTravel, for the same reason.
 */
export function useTaxi(): TaxiState {
  const [state, setState] = useState<TaxiState>({ fleet: null, error: null });

  useEffect(() => {
    let cancelled = false;
    getTaxi()
      .then((fleet) => {
        if (!cancelled) setState({ fleet, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          fleet: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
