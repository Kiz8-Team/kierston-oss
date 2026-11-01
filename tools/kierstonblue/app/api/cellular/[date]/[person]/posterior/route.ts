import { readPosterior } from "@/lib/server/cellular";

/** The 95% region behind a fused step (`?minute=`) or a single record (`?record=`). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ date: string; person: string }> },
) {
  const { date, person: raw } = await params;
  const person = Number(raw);
  const url = new URL(request.url);
  const handset = Number(url.searchParams.get("handset") ?? 0);
  const record = url.searchParams.get("record");
  const minute = Number(url.searchParams.get("minute") ?? 0);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(person) || person < 0
    || !Number.isSafeInteger(handset) || handset < 0) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  try {
    const cells = await readPosterior(date, person, handset, record !== null
      ? { mode: "record", id: Number(record) }
      : { mode: "track", minute });
    return cells
      ? Response.json(cells)
      : Response.json({ error: "no posterior" }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
  }
}
