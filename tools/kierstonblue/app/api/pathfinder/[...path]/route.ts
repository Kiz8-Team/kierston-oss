/**
 * Proxy to the Bun pathfinder service (kierston/pathfinder, `bun run serve`).
 *
 * Routing keeps the road graph, the address index and the search in one
 * long-lived process; re-implementing it here would mean loading a 3 MB graph
 * into every Next.js worker. Proxying instead means the browser talks to one
 * origin and never has to know which port the router is on.
 */

const PATHFINDER = process.env.PATHFINDER_URL ?? "http://localhost:8787";

async function forward(request: Request, path: string[]): Promise<Response> {
  const incoming = new URL(request.url);
  const target = new URL(`/api/${path.join("/")}${incoming.search}`, PATHFINDER);
  try {
    const response = await fetch(target, {
      method: request.method,
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "Content-Type": response.headers.get("Content-Type") ?? "application/json" },
    });
  } catch {
    return Response.json(
      {
        error: "pathfinder not running",
        code: "unreachable",
        hint: "cd kierston/pathfinder && bun run serve",
        service: PATHFINDER,
      },
      { status: 503 },
    );
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ path: string[] }> }) {
  return forward(request, (await params).path);
}
