import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { JobsBrowser } from "@/components/work/JobsBrowser";

export const metadata = { title: "Jobs · KierstonBlue" };

export default function WorkPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading jobs…</EmptyState>
        </main>
      }
    >
      <JobsBrowser />
    </Suspense>
  );
}
