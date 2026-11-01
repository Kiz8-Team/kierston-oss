import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { PersonRecord } from "@/components/records/PersonRecord";

export const metadata = { title: "Full personal record · KierstonBlue" };

export default function RecordPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading…</EmptyState>
        </main>
      }
    >
      <PersonRecord />
    </Suspense>
  );
}
