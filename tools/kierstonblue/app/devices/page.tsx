import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { IdentityWorkspace } from "@/components/records/RecordsWorkspace";
import { DEVICE_TABS } from "@/lib/record-views";

export const metadata = { title: "Phones and lines · KierstonBlue" };

export default function DevicesPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading handsets…</EmptyState>
        </main>
      }
    >
      <IdentityWorkspace
        title="Phones and lines"
        tabs={DEVICE_TABS}
        generator="python kierston/init/personal_records/devices.py"
      />
    </Suspense>
  );
}
