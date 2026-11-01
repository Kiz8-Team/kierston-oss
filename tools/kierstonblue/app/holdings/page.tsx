import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { RecordsWorkspace } from "@/components/records/RecordsWorkspace";
import { HOLDING_TABS } from "@/lib/record-views";

export const metadata = { title: "Holdings · KierstonBlue" };

export default function HoldingsPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading holdings…</EmptyState>
        </main>
      }
    >
      <RecordsWorkspace
        dataset="holdings"
        title="Holdings"
        tabs={HOLDING_TABS}
        generator="python kierston/init/personal_records/holdings.py"
      />
    </Suspense>
  );
}
