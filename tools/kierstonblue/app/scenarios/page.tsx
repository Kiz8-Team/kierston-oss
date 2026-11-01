import { Suspense } from "react";
import { ScenarioWorkspace } from "@/components/scenario/ScenarioWorkspace";
import { EmptyState } from "@/components/browse/EmptyState";

export const metadata = { title: "Scenarios · KierstonBlue" };

export default function ScenariosPage() {
  return (
    <Suspense fallback={
      <main id="content" className="relative h-full overflow-auto">
        <EmptyState>Loading scenario deltas…</EmptyState>
      </main>
    }>
      <ScenarioWorkspace />
    </Suspense>
  );
}
