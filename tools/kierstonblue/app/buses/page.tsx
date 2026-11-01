import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { BusBrowser } from "@/components/school/BusBrowser";

export const metadata = { title: "School buses · KierstonBlue" };

export default function BusesPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading school travel…</EmptyState>
        </main>
      }
    >
      <BusBrowser />
    </Suspense>
  );
}
