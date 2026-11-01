import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { RecordsWorkspace } from "@/components/records/RecordsWorkspace";
import { CRIMINAL_TABS } from "@/lib/record-views";

export const metadata = { title: "Criminal record · KierstonBlue" };

export default function CriminalPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading criminal records…</EmptyState>
        </main>
      }
    >
      <RecordsWorkspace
        dataset="criminal"
        title="Criminal record"
        tabs={CRIMINAL_TABS}
        generator="python kierston/init/criminal_history/dockets.py"
      />
    </Suspense>
  );
}
