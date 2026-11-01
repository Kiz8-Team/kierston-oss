import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { NetworkWorkspace } from "@/components/network/NetworkWorkspace";

export const metadata = { title: "Cell network · KierstonBlue" };

export default function TowersPage() {
  return (
    <main id="content" className="relative h-full overflow-hidden">
      <Suspense fallback={<EmptyState>Loading…</EmptyState>}>
        <NetworkWorkspace />
      </Suspense>
    </main>
  );
}
