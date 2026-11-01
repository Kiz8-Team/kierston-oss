import { randomPhonePerson } from "@/lib/server/cellular";

/** A random resident with network events and at least one journey. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ date: string }> },
) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "invalid date" }, { status: 400 });
  try {
    const person = await randomPhonePerson(date);
    return person === null
      ? Response.json({ error: "no resident with a handset found" }, { status: 404 })
      : Response.json({ person });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
