import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { TaxiBrowser } from "@/components/taxi/TaxiBrowser";

export const metadata = { title: "Taxis · KierstonBlue" };

export default function TaxiPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading…</EmptyState>
        </main>
      }
    >
      <TaxiBrowser />
    </Suspense>
  );
}
