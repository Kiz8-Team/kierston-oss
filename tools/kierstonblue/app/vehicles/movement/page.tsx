import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { VehicleFinder } from "@/components/vehicles/VehicleFinder";

export const metadata = { title: "Vehicle movement · KierstonBlue" };

export default function VehicleMovementFinderPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading generated days…</EmptyState>
        </main>
      }
    >
      <VehicleFinder />
    </Suspense>
  );
}
