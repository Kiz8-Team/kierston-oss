import { readCellularEstimate } from "@/lib/server/cellular";

/** One resident's handsets, located from carrier records alone and scored against truth. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ date: string; person: string }> },
) {
  const { date, person: raw } = await params;
  const person = Number(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(person) || person < 0) {
    return Response.json({ error: "invalid date or resident id" }, { status: 400 });
  }
  try {
    const estimate = await readCellularEstimate(date, person);
    return estimate
      ? Response.json(estimate)
      : Response.json({ error: `no resident ${person} in ${date}` }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
