"use client";

import { useMemo } from "react";
import { BankingOverview } from "@/components/banking/BankingOverview";
import { EmptyState } from "@/components/browse/EmptyState";
import { RecordBrowser } from "@/components/records/RecordBrowser";
import { useRecords } from "@/components/useRecords";
import { hasBanking, summariseBanking } from "@/lib/banking-summary";
import { num } from "@/lib/format";
import { BANKING_TABS } from "@/lib/record-views";
import type { RecordSet } from "@/lib/records";

/**
 * The banking page: the city's position first, then the five tables behind it.
 *
 * Reads holdings.bin, which it shares with the holdings page through the module
 * cache in lib/datasets — arriving here from there costs nothing, and the
 * aggregate is computed once per load rather than per tab.
 *
 * A holdings file built before banking.py existed has no income streams and no
 * balances, and every figure on the overview would come back zero without
 * saying why. That case gets told what to run instead.
 */

const GENERATOR = "python kierston/init/personal_records/holdings.py";

function lead(records: RecordSet | null): string {
  if (!records) return "";
  const counts = BANKING_TABS
    .filter((tab) => records.tableNames.includes(tab.table))
    // The tab label is the word on the strip and too short to stand alone in
    // a sentence — "85,474 income" is not a count of anything. The noun is.
    .map((tab) => `${num(records.table(tab.table).rows)} `
      + `${(tab.noun ?? tab.table).toLowerCase()}s`);
  return [
    ...counts,
    `seed ${records.meta.seed}`,
    `as of ${records.meta.today ?? records.meta.referenceYear}`,
  ].join(" · ");
}

export function BankingWorkspace() {
  const { population, identity, records, error } = useRecords("holdings");

  const banking = records != null && hasBanking(records);
  const summary = useMemo(
    () => (banking && population ? summariseBanking(records!, population) : null),
    [banking, records, population],
  );

  // Tabs are filtered to the tables the file actually carries, because
  // RecordSet.table throws on a name it has never heard of and a tab strip is
  // not the place to find that out.
  const tabs = useMemo(
    () => (records
      ? BANKING_TABS.filter((tab) => records.tableNames.includes(tab.table))
      : BANKING_TABS),
    [records],
  );

  if (records && !banking) {
    return (
      <main id="content" className="relative h-full overflow-auto">
        <EmptyState title="No banking tables">
          <p>
            <code className="font-sans text-[max(0.75rem,0.8em)]">{GENERATOR}</code>
            <br />
            <code className="font-sans text-[max(0.75rem,0.8em)]">
              python kierston/init/personal_records/pack_records.py
            </code>
          </p>
        </EmptyState>
      </main>
    );
  }

  return (
    <RecordBrowser
      title="Banking"
      lead={lead(records)}
      tabs={tabs}
      records={records}
      identity={identity}
      population={population}
      error={error}
      generator={GENERATOR}
      overview={{
        label: "Position",
        content: summary
          ? <BankingOverview summary={summary} />
          : <EmptyState>Loading…</EmptyState>,
      }}
    />
  );
}
