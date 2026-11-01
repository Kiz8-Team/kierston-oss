import { Suspense } from "react";
import { MeetingsBrowser } from "@/components/meetings/MeetingsBrowser";
import { EmptyState } from "@/components/browse/EmptyState";

export const metadata = { title: "Gatherings · KierstonBlue" };

export default function MeetingsPage() {
  return (
    <Suspense fallback={<main id="content" className="relative h-full overflow-auto"><EmptyState>Loading gatherings…</EmptyState></main>}>
      <MeetingsBrowser />
    </Suspense>
  );
}
