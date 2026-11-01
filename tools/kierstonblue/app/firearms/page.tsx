import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { RecordsWorkspace } from "@/components/records/RecordsWorkspace";
import { FIREARM_TABS } from "@/lib/record-views";

export const metadata = { title: "Firearms · KierstonBlue" };

export default function FirearmsPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading firearms…</EmptyState>
        </main>
      }
    >
      <RecordsWorkspace
        dataset="firearms"
        title="Firearms"
        tabs={FIREARM_TABS}
        generator="python kierston/init/personal_records/holdings.py"
      />
    </Suspense>
  );
}
