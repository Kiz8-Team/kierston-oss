"use client";

import { useEffect, useState } from "react";
import {
  RECORD_DATASETS, getEmployment, getEnrollment, getIdentity, getKinship,
  getLabels, getPopulation, getRecords, type RecordDataset,
} from "@/lib/datasets";
import type { Employment } from "@/lib/employment";
import type { Enrollment } from "@/lib/enrollment";
import type { Identity } from "@/lib/identity";
import type { Kinship } from "@/lib/kinship";
import type { Labels } from "@/lib/labels";
import type { Population } from "@/lib/population";
import type { RecordSet } from "@/lib/records";

export interface RecordsState {
  population: Population | null;
  identity: Identity | null;
  records: RecordSet | null;
  error: string | null;
  elapsed: number | null;
}

/**
 * One record file, plus the two datasets every record needs to mean anything.
 *
 * The same contract as useEmployment and useEnrollment. A firearms row says
 * resident 8,412 bought a shotgun in 2017; the identity file turns that into a
 * person with a name and a birthday, and the population turns it into someone
 * with an age, a household and an address. All three come from the
 * module-level cache in lib/datasets, so moving between the records pages pays
 * for identity.bin once and only fetches the file each page actually browses.
 */
export function useRecords(dataset: RecordDataset): RecordsState {
  const [state, setState] = useState<RecordsState>({
    population: null, identity: null, records: null, error: null, elapsed: null,
  });

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    setState({
      population: null, identity: null, records: null, error: null, elapsed: null,
    });
    Promise.all([getPopulation(), getIdentity(), getRecords(dataset)])
      .then(([population, identity, records]) => {
        if (cancelled) return;
        setState({
          population, identity, records,
          error: null,
          elapsed: performance.now() - started,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          population: null, identity: null, records: null,
          error: error instanceof Error ? error.message : String(error),
          elapsed: null,
        });
      });
    return () => { cancelled = true; };
  }, [dataset]);

  return state;
}

export interface DossierState {
  population: Population | null;
  identity: Identity | null;
  employment: Employment | null;
  enrollment: Enrollment | null;
  /** Parents, children, siblings and partner — the one edge set that reaches
      outside the household the person sleeps in. */
  kinship: Kinship | null;
  /** The PUMS code books, so the record can name an occupation rather than
      print its OCCP code at a reader who does not have the book to hand. */
  labels: Labels | null;
  sets: Partial<Record<RecordDataset, RecordSet>>;
  error: string | null;
  elapsed: number | null;
}

/**
 * Every dataset at once, for the full personal record.
 *
 * This is the one page that loads all of it — about 75 MB across nine files —
 * because a dossier that stopped at firearms would not be one. It is also the
 * page where that cost pays back best: the whole point is to move between
 * people, and once the files are in the module cache each subsequent person is
 * a handful of index lookups with nothing fetched at all.
 *
 * Everything loads in parallel and shares the cache with the other pages, so a
 * reader arriving here from the firearms table has already paid for two of the
 * nine.
 */
export function useDossierData(): DossierState {
  const [state, setState] = useState<DossierState>({
    population: null, identity: null, employment: null, enrollment: null,
    kinship: null, labels: null, sets: {}, error: null, elapsed: null,
  });

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    Promise.all([
      getPopulation(),
      getIdentity(),
      getEmployment(),
      getEnrollment(),
      // The one optional dataset here. kinship.json comes from a stage that
      // was added after the record files, so a sim_data built before it is a
      // record page without a family section rather than a page that refuses
      // to load — the same bargain init_sim.py makes between its own stages.
      getKinship().catch(() => null),
      getLabels(),
      ...RECORD_DATASETS.map((dataset) => getRecords(dataset)),
    ])
      .then(([population, identity, employment, enrollment, kinship, labels, ...records]) => {
        if (cancelled) return;
        const sets: Partial<Record<RecordDataset, RecordSet>> = {};
        RECORD_DATASETS.forEach((dataset, index) => { sets[dataset] = records[index]; });
        setState({
          population, identity, employment, enrollment, kinship, labels, sets,
          error: null,
          elapsed: performance.now() - started,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          population: null, identity: null, employment: null, enrollment: null,
          kinship: null, labels: null, sets: {},
          error: error instanceof Error ? error.message : String(error),
          elapsed: null,
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}

export interface IdentityState {
  population: Population | null;
  identity: Identity | null;
  error: string | null;
  elapsed: number | null;
}

/** The identities page itself, which needs no second record file. */
export function useIdentity(): IdentityState {
  const [state, setState] = useState<IdentityState>({
    population: null, identity: null, error: null, elapsed: null,
  });

  useEffect(() => {
    let cancelled = false;
    const started = performance.now();
    Promise.all([getPopulation(), getIdentity()])
      .then(([population, identity]) => {
        if (cancelled) return;
        setState({
          population, identity, error: null, elapsed: performance.now() - started,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          population: null, identity: null,
          error: error instanceof Error ? error.message : String(error),
          elapsed: null,
        });
      });
    return () => { cancelled = true; };
  }, []);

  return state;
}
