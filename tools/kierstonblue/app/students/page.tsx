import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { StudentsBrowser } from "@/components/school/StudentsBrowser";

export const metadata = { title: "Students · KierstonBlue" };

export default function StudentsPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading students…</EmptyState>
        </main>
      }
    >
      <StudentsBrowser />
    </Suspense>
  );
}
