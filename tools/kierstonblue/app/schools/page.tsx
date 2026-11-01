import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { SchoolBrowser } from "@/components/school/SchoolBrowser";

export const metadata = { title: "Schools · KierstonBlue" };

export default function SchoolsPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading schools…</EmptyState>
        </main>
      }
    >
      <SchoolBrowser />
    </Suspense>
  );
}
