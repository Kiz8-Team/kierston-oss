import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { SpendingWorkspace } from "@/components/spending/SpendingWorkspace";

export const metadata = { title: "Spending · KierstonBlue" };

export default function SpendingPage() {
  return (
    <Suspense fallback={
      <main id="content" className="relative h-full overflow-auto">
        <EmptyState>Loading generated days…</EmptyState>
      </main>
    }>
      <SpendingWorkspace />
    </Suspense>
  );
}
