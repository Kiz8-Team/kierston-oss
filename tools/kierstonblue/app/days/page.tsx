import { Suspense } from "react";
import { DayBrowser } from "@/components/day/DayBrowser";
import { EmptyState } from "@/components/browse/EmptyState";

export const metadata = { title: "Daily movement · KierstonBlue" };

export default function DaysPage() {
  return (
    <Suspense fallback={<main id="content" className="relative h-full overflow-auto"><EmptyState>Loading generated days…</EmptyState></main>}>
      <DayBrowser />
    </Suspense>
  );
}
