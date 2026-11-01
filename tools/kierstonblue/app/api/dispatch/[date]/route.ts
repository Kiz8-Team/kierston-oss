import { readDispatchIndex } from "@/lib/server/dispatch";

/** Every call for service in one day file, with the units sent to each. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ date: string }> },
) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "invalid date" }, { status: 400 });
  }
  try {
    const index = await readDispatchIndex(date);
    return index
      ? Response.json(index)
      : Response.json({ error: `no day file for ${date}` }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
