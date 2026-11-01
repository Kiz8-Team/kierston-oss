import { listDays } from "@/lib/server/day";

export async function GET() {
  try {
    return Response.json({ days: await listDays() });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
