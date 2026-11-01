import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { SocialBrowser } from "@/components/social/SocialBrowser";

export const metadata = { title: "Social graph · KierstonBlue" };

export default function SocialPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading…</EmptyState>
        </main>
      }
    >
      <SocialBrowser />
    </Suspense>
  );
}
