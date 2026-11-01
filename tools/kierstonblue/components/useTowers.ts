"use client";

import { useEffect, useState } from "react";
import { getTowers } from "@/lib/datasets";
import type { Network } from "@/lib/towers";

export interface NetworkState {
  network: Network | null;
  error: string | null;
}

/**
 * The cell network, or the reason there isn't one.
 *
 * Same contract as useTaxi: a missing towers.json is a state to explain rather
 * than an error to swallow, because it is written by a late init stage and an
 * older sim_data will not have it.
 */
export function useTowers(): NetworkState {
  const [state, setState] = useState<NetworkState>({ network: null, error: null });

  useEffect(() => {
    let cancelled = false;
    getTowers()
      .then((network) => {
        if (!cancelled) setState({ network, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          network: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
