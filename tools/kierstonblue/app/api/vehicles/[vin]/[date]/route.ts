import { readVehicleDay } from "@/lib/server/vehicles";

/** One vehicle's own day: every span of it, parked and moving, and who was in it. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ vin: string; date: string }> },
) {
  const { vin: raw, date } = await params;
  const vin = decodeURIComponent(raw);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !vin) {
    return Response.json({ error: "invalid VIN or date" }, { status: 400 });
  }
  try {
    const day = await readVehicleDay(date, vin);
    return day
      ? Response.json(day)
      : Response.json(
        { error: `no movement record for ${vin} in ${date}` },
        { status: 404 },
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
