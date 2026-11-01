"use client";

import { useEffect, useState } from "react";
import { getIdentity } from "@/lib/datasets";
import type { Identity } from "@/lib/identity";

/**
 * Names for the pages that are not about names.
 *
 * The households, people, jobs and students tables predate the personal
 * records and refer to everyone by resident id. They only need two things out
 * of identity.bin — a name and the fact that the person exists — so this is
 * useIdentity without the population, and without the error: a page that ran
 * before the identity generator did must keep working, so a missing file
 * leaves the hook at null and every caller falls back to "Resident 41207".
 *
 * The file is shared with the records pages through the module-level cache in
 * lib/datasets, so the first page that asks pays for it and the rest do not.
 */
export function useNames(): Identity | null {
  const [identity, setIdentity] = useState<Identity | null>(null);

  useEffect(() => {
    let cancelled = false;
    getIdentity()
      .then((loaded) => { if (!cancelled) setIdentity(loaded); })
      .catch(() => { /* No identity file: ids stay ids. */ });
    return () => { cancelled = true; };
  }, []);

  return identity;
}
