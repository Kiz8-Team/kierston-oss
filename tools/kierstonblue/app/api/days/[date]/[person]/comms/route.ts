import { readPersonComms } from "@/lib/server/comms";

/**
 * Beside the person's day rather than part of it.
 *
 * The movement page has no use for five million messages and the joins that
 * reach them cost a pass over the file, so a reader who only wants a schedule
 * and a map does not pay for one. Same file, same date, one more request.
 */
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
    const comms = await readPersonComms(date, person);
    return comms
      ? Response.json(comms)
      : Response.json({ error: `no resident ${person} in this day` }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /ENOENT/.test(message) ? 404 : 500;
    return Response.json({ error: message }, { status });
  }
}
