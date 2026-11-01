import { readDaySpending } from "@/lib/server/day";

/**
 * The whole day's money, aggregated on the server.
 *
 * Server-side because the alternative is shipping a few hundred thousand
 * transaction rows to the browser to add up — the aggregate is a few kilobytes
 * and the rows are tens of megabytes. A static segment sitting beside the
 * `[person]` one: Next matches this first, so no resident is ever named
 * "spending".
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ date: string }> },
) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "invalid date" }, { status: 400 });
  }
  try {
    const spending = await readDaySpending(date);
    return spending
      ? Response.json(spending)
      : Response.json({ error: `no generated day for ${date}` }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
