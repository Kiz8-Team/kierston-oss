import { readIncident } from "@/lib/server/dispatch";

/** One incident, with the responding vehicles' movement around it. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ date: string; index: string }> },
) {
  const { date, index: raw } = await params;
  const index = Number(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(index) || index < 0) {
    return Response.json({ error: "invalid date or incident" }, { status: 400 });
  }
  try {
    const detail = await readIncident(date, index);
    return detail
      ? Response.json(detail)
      : Response.json({ error: `no incident ${index} in ${date}` }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
