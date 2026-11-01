import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { MapWorkspace } from "@/components/map/MapWorkspace";

export const metadata = { title: "Map · KierstonBlue" };

export default function MapPage() {
  return (
    <main id="content" className="relative h-full overflow-hidden">
      <Suspense fallback={<EmptyState>Loading…</EmptyState>}>
        <MapWorkspace />
      </Suspense>
    </main>
  );
}
