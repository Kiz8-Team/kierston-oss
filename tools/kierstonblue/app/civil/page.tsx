import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { RecordsWorkspace } from "@/components/records/RecordsWorkspace";
import { CIVIL_TABS } from "@/lib/record-views";

export const metadata = { title: "Civil and family · KierstonBlue" };

export default function CivilPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading civil dockets…</EmptyState>
        </main>
      }
    >
      <RecordsWorkspace
        dataset="civil"
        title="Civil and family"
        tabs={CIVIL_TABS}
        generator="python kierston/init/criminal_history/dockets.py"
      />
    </Suspense>
  );
}
