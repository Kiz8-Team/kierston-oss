import { Suspense } from "react";
import { BankingWorkspace } from "@/components/banking/BankingWorkspace";
import { EmptyState } from "@/components/browse/EmptyState";

export const metadata = { title: "Banking · KierstonBlue" };

export default function BankingPage() {
  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading banking…</EmptyState>
        </main>
      }
    >
      <BankingWorkspace />
    </Suspense>
  );
}
