import { Suspense } from "react";
import { DispatchBrowser } from "@/components/dispatch/DispatchBrowser";
import { EmptyState } from "@/components/browse/EmptyState";

export const metadata = { title: "911 calls · KierstonBlue" };

export default function DispatchPage() {
  return (
    <Suspense fallback={<main id="content" className="relative h-full overflow-auto"><EmptyState>Loading calls…</EmptyState></main>}>
      <DispatchBrowser />
    </Suspense>
  );
}
