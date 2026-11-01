"use client";

import { useEffect, useState } from "react";
import { getEnrollment, getSchoolTravel } from "@/lib/datasets";
import type { Enrollment } from "@/lib/enrollment";
import type { SchoolTravel } from "@/lib/school-travel";

export interface TravelState {
  travel: SchoolTravel | null;
  enrollment: Enrollment | null;
  error: string | null;
}

/**
 * The school-travel layer and the enrollment it is joined against.
 *
 * The enrollment comes back as well because the two answer different halves of
 * the same question: this file says a student rides the 7:12 elementary run,
 * and the enrollment says which school that run is taking them to and how far
 * it is. Both are in the module-level cache, so asking for them here costs
 * nothing on top of what the students and schools tables already loaded.
 *
 * A missing school_travel.json is a real state and not an error to hide: the
 * stage runs late in the pipeline, and somebody with an older build should be
 * told which script to run rather than shown an empty table.
 */
export function useSchoolTravel(): TravelState {
  const [state, setState] = useState<TravelState>({
    travel: null, enrollment: null, error: null,
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([getSchoolTravel(), getEnrollment()])
      .then(([travel, enrollment]) => {
        if (!cancelled) setState({ travel, enrollment, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          travel: null,
          enrollment: null,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
