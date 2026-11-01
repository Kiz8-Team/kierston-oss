"use client";

import { useEffect, useState } from "react";
import { getCameras } from "@/lib/datasets";
import type { CameraFleet } from "@/lib/cameras";

export interface FleetState {
  fleet: CameraFleet | null;
  error: string | null;
}

export function useCameras(): FleetState {
  const [state, setState] = useState<FleetState>({ fleet: null, error: null });

  useEffect(() => {
    let cancelled = false;
    getCameras()
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
