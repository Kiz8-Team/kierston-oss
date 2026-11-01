import { readCameraDay } from "@/lib/server/alpr";

/** One camera's reads on one generated day, truth beside observation. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ date: string; camera: string }> },
) {
  const { date, camera: raw } = await params;
  const camera = decodeURIComponent(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !camera) {
    return Response.json({ error: "invalid date or camera" }, { status: 400 });
  }
  try {
    const day = await readCameraDay(date, camera);
    return day
      ? Response.json(day)
      : Response.json({ error: `no camera ${camera} in ${date}` }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
