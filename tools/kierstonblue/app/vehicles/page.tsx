import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { RecordsWorkspace } from "@/components/records/RecordsWorkspace";
import { VEHICLE_TABS } from "@/lib/record-views";

export const metadata = { title: "Vehicles and licences · KierstonBlue" };

export default function VehiclesPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading vehicles…</EmptyState>
        </main>
      }
    >
      <RecordsWorkspace
        dataset="vehicles"
        title="Vehicles and licences"
        tabs={VEHICLE_TABS}
        generator="python kierston/init/personal_records/holdings.py"
      />
    </Suspense>
  );
}
