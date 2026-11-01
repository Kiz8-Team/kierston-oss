"use client";

import { useEffect, useState } from "react";
import { getIdentity, getPopulation, getTies } from "@/lib/datasets";
import type { Identity } from "@/lib/identity";
import type { Population } from "@/lib/population";
import type { TieGraph } from "@/lib/ties";

export interface TiesState {
  population: Population | null;
  identity: Identity | null;
  ties: TieGraph | null;
  error: string | null;
  elapsed: number | null;
}

/**
 * The social graph, with the two datasets that make an edge mean anything.
 *
 * A tie says resident 41,207 sees resident 8,412 daily and would not call
 * them; the identity file turns both into people with names, and the
 * population gives them the ages the diagram sorts and the labels read. All
 * three come from the module-level cache in lib/datasets, so arriving here
 * from any other page has already paid for two of the three.
 *
 * This is the app's largest single load — 55 MB, plus the index built over it
 * — so `elapsed` is reported and the page says so while it waits.
 */
export function useTies(): TiesState {
  const [state, setState] = useState<TiesState>({
    population: null, identity: null, ties: null, error: null, elapsed: null,
  });

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    Promise.all([getPopulation(), getIdentity(), getTies()])
      .then(([population, identity, ties]) => {
        if (cancelled) return;
        setState({
          population, identity, ties,
          error: null,
          elapsed: performance.now() - started,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          population: null, identity: null, ties: null,
          error: error instanceof Error ? error.message : String(error),
          elapsed: null,
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}

/**
 * The graph on its own, for a page that is about something else.
 *
 * The same contract useNames has: the record page predates ties.bin and must
 * keep working without it, so a missing file leaves this at null and the
 * social section simply is not drawn.
 */
export function useTieGraph(): TieGraph | null {
  const [ties, setTies] = useState<TieGraph | null>(null);

  useEffect(() => {
    let cancelled = false;
    getTies()
      .then((graph) => { if (!cancelled) setTies(graph); })
      .catch(() => { /* No ties file: no social section. */ });
    return () => { cancelled = true; };
  }, []);

  return ties;
}
