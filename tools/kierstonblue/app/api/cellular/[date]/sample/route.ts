import { sampleCellular } from "@/lib/server/cellular";

/** Accuracy over a random sample of residents (`?n=`, at most 200). */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ date: string }> },
) {
  const { date } = await params;
  const n = Math.min(200, Math.max(1, Number(new URL(request.url).searchParams.get("n") ?? 30) || 30));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return Response.json({ error: "invalid date" }, { status: 400 });
  try {
    const result = await sampleCellular(date, n);
    return result
      ? Response.json(result)
      : Response.json({ error: `no day file for ${date}` }, { status: 404 });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
