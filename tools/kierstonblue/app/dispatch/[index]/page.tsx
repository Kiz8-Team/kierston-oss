import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { IncidentView } from "@/components/dispatch/IncidentView";
import { pickDay } from "@/lib/server/day";

export const metadata = { title: "911 call · KierstonBlue" };

/**
 * A call has a URL of its own. The date is a query, as for a gathering: an
 * incident index only means something inside one day file, and a link without
 * a date opens the most recent one.
 */
export default async function IncidentPage({
  params, searchParams,
}: {
  params: Promise<{ index: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const [{ index: raw }, { date: wanted }] = await Promise.all([params, searchParams]);
  const index = Number(raw);
  const date = await pickDay(wanted);

  if (!Number.isSafeInteger(index) || index < 0 || !date) {
    return (
      <main id="content" className="relative h-full overflow-auto">
        <EmptyState title="No such call" />
      </main>
    );
  }

  return (
    <Suspense fallback={<main id="content" className="relative h-full overflow-auto"><EmptyState>Loading…</EmptyState></main>}>
      <IncidentView date={date} index={index} />
    </Suspense>
  );
}
