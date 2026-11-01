import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { VehicleBrowser } from "@/components/vehicles/VehicleBrowser";

export async function generateMetadata(
  { params }: { params: Promise<{ vin: string }> },
) {
  const { vin } = await params;
  return { title: `${decodeURIComponent(vin)} · KierstonBlue` };
}

export default async function VehicleMovementPage(
  { params }: { params: Promise<{ vin: string }> },
) {
  const { vin } = await params;
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading…</EmptyState>
        </main>
      }
    >
      <VehicleBrowser vin={decodeURIComponent(vin)} />
    </Suspense>
  );
}
