import { searchVehicles } from "@/lib/server/vehicles";

/**
 * The vehicles a search names on one date.
 *
 * Answered on the server against the cached register rather than by shipping
 * sixty thousand rows to the browser to filter: the question is always "which
 * few", and the few are what comes back.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const date = url.searchParams.get("date") ?? "";
  const query = url.searchParams.get("q") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "invalid date" }, { status: 400 });
  }
  try {
    const found = await searchVehicles(date, query);
    return found
      ? Response.json({ vehicles: found })
      : Response.json({ error: `no day file for ${date}` }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
