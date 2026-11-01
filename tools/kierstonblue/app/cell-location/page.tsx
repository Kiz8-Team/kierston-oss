import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { CellularWorkspace } from "@/components/cellular/CellularWorkspace";

export const metadata = { title: "Cell location estimator · KierstonBlue" };

export default function CellLocationPage() {
  return (
    <Suspense fallback={<main id="content" className="relative h-full overflow-auto"><EmptyState>Loading…</EmptyState></main>}>
      <CellularWorkspace />
    </Suspense>
  );
}
