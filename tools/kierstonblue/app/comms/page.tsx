import { Suspense } from "react";
import { CommsWorkspace } from "@/components/comms/CommsWorkspace";
import { EmptyState } from "@/components/browse/EmptyState";

export const metadata = { title: "Messages and calls · KierstonBlue" };

export default function CommsPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading conversations…</EmptyState>
        </main>
      }
    >
      <CommsWorkspace />
    </Suspense>
  );
}
