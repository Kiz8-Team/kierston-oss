import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { MeetingView } from "@/components/meetings/MeetingView";
import { pickDay } from "@/lib/server/day";

export const metadata = { title: "Gathering · KierstonBlue" };

/**
 * A gathering has a URL of its own.
 *
 * The date is a query rather than part of the path because a meeting index is
 * only meaningful inside one exported file, and a link that omits the date
 * should still open something: the most recent day is what a reader arriving
 * without one means. Resolved on the server, so the page does not flash an
 * empty state while a client works out which files exist.
 */
export default async function MeetingPage({
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
        <EmptyState title={date ? "No such gathering" : "No generated days"}>
          {date ? null : (
            <code>cd kierston/sim &amp;&amp; bun run day --export-day --date YYYY-MM-DD</code>
          )}
        </EmptyState>
      </main>
    );
  }

  return (
    <Suspense fallback={<main id="content" className="relative h-full overflow-auto"><EmptyState>Loading…</EmptyState></main>}>
      <MeetingView date={date} index={index} />
    </Suspense>
  );
}
