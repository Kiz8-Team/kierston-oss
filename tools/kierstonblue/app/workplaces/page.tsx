import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { WorkplaceBrowser } from "@/components/work/WorkplaceBrowser";

export const metadata = { title: "Workplaces · KierstonBlue" };

export default function WorkplacesPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading workplaces…</EmptyState>
        </main>
      }
    >
      <WorkplaceBrowser />
    </Suspense>
  );
}
