import { Suspense } from "react";
import { EmptyState } from "@/components/browse/EmptyState";
import { CameraReads } from "@/components/cameras/CameraReads";
import { pickDay } from "@/lib/server/day";

export const metadata = { title: "Plate reader · KierstonBlue" };

/**
 * One camera has a URL of its own.
 *
 * Keyed on the siting id rather than on a row number, because `ALPR-023` is
 * what every other file in this project calls this camera and a row in the day
 * table is only meaningful inside one exported file. The date is a query for
 * the same reason it is on the gathering page: a link that omits it should
 * still open something, and the most recent generated day is what somebody
 * arriving without one means. Resolved on the server so the page does not
 * flash an empty state while a client works out which files exist.
 */
export default async function CameraPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const [{ id: raw }, { date: wanted }] = await Promise.all([params, searchParams]);
  const id = decodeURIComponent(raw);
  const date = await pickDay(wanted);

  if (!id || !date) {
    return (
      <main id="content" className="relative h-full overflow-auto">
        <EmptyState title={id ? "No generated days" : "No such camera"}>
          {id ? (
            <code>cd kierston/sim &amp;&amp; bun run day --export-day --date YYYY-MM-DD</code>
          ) : null}
        </EmptyState>
      </main>
    );
  }

  return (
    <Suspense
      fallback={
        <main id="content" className="relative h-full overflow-auto">
          <EmptyState>Loading…</EmptyState>
        </main>
      }
    >
      <CameraReads id={id} date={date} />
    </Suspense>
  );
}
