import { readMeeting } from "@/lib/server/meetings";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ date: string; index: string }> },
) {
  const { date, index: raw } = await params;
  const index = Number(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isSafeInteger(index) || index < 0) {
    return Response.json({ error: "invalid date or meeting" }, { status: 400 });
  }
  try {
    const meeting = await readMeeting(date, index);
    return meeting
      ? Response.json(meeting)
      : Response.json({ error: `no gathering ${index} in ${date}` }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
