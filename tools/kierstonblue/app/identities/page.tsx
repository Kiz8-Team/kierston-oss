import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { IdentityWorkspace } from "@/components/records/RecordsWorkspace";
import { IDENTITY_TABS } from "@/lib/record-views";

export const metadata = { title: "Identities · KierstonBlue" };

export default function IdentitiesPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading identities…</EmptyState>
        </main>
      }
    >
      <IdentityWorkspace title="Identities" tabs={IDENTITY_TABS} />
    </Suspense>
  );
}
