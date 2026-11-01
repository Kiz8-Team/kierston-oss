"use client";

import { useEffect, useState } from "react";
import { RecordBrowser, type TabDef } from "@/components/records/RecordBrowser";
import { useIdentity, useRecords } from "@/components/useRecords";
import { getFleet, type RecordDataset } from "@/lib/datasets";
import { humanise, num } from "@/lib/format";
import type { RecordSet } from "@/lib/records";

/**
 * The thin part of a records page: load a file, hand it to the browser.
 *
 * Every page except the identities one is this component with a different
 * dataset and a different set of tabs. The counts in the lead come from the
 * packer's header rather than from a hand-written sentence, so they stay true
 * when a generator is re-run with a different seed.
 */

function lead(records: RecordSet | null): string {
  if (!records) return "";
  const parts = Object.entries(records.meta.counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${num(count)} ${humanise(name).toLowerCase()}`);
  return [...parts, `seed ${records.meta.seed}`, `as of ${records.meta.referenceYear}`].join(" · ");
}

export function RecordsWorkspace({ dataset, title, tabs, generator }: {
  dataset: RecordDataset;
  title: string;
  tabs: TabDef[];
  generator: string;
}) {
  const { population, identity, records, error } = useRecords(dataset);
  const [ownerNames, setOwnerNames] = useState<Map<number, string> | undefined>();
  useEffect(() => {
    if (dataset !== "vehicles") return;
    void getFleet().then((fleet) => setOwnerNames(new Map(
      fleet.operators.map((operator) => [operator.id, operator.name]),
    )));
  }, [dataset]);
  return (
    <RecordBrowser
      title={title}
      lead={lead(records)}
      tabs={tabs}
      records={records}
      identity={identity}
      population={population}
      error={error}
      generator={generator}
      ownerNames={ownerNames}
    />
  );
}

/**
 * The identities page, which is the one file every other page also loads.
 *
 * It goes through useIdentity rather than useRecords because there is no
 * second record file to wait for — the Identity wrapper already holds the set
 * the browser needs.
 *
 * The devices page is the same file read through different tabs: handsets and
 * subscriptions are packed into identity.bin as child tables, so they need no
 * fetch of their own. They come from a different generator, though, which is
 * why the command is a prop rather than the constant it used to be.
 */
export function IdentityWorkspace({ title, tabs, generator }: {
  title: string;
  tabs: TabDef[];
  generator?: string;
}) {
  const { population, identity, error } = useIdentity();
  return (
    <RecordBrowser
      title={title}
      lead={lead(identity?.set ?? null)}
      tabs={tabs}
      records={identity?.set ?? null}
      identity={identity}
      population={population}
      error={error}
      generator={generator ?? "python kierston/init/personal_records/identity.py"}
    />
  );
}
