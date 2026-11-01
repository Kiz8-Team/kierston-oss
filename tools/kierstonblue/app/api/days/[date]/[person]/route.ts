import { readPersonDay } from "@/lib/server/day";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ date: string; person: string }> },
) {
  const { date, person: rawPerson } = await params;
  const person = Number(rawPerson);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(person) || person < 0) {
    return Response.json({ error: "invalid date or resident id" }, { status: 400 });
  }
  try {
    const day = await readPersonDay(date, person);
    return day
      ? Response.json(day)
      : Response.json({ error: `no resident ${person} in this day` }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /ENOENT/.test(message) ? 404 : 500;
    return Response.json({ error: message }, { status });
  }
}
