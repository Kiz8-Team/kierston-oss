/**
 * The pathfinder as a small HTTP service.
 *
 * It also serves the repository as static files, so `tools/map` can be opened
 * from the same origin as the API and no second server is needed:
 *
 *   bun run serve            → http://localhost:8787/tools/map/pathfinder.html
 *
 * Endpoints
 *   GET /api/health                    graph and index statistics
 *   GET /api/geocode?q=&limit=         ranked address candidates
 *   GET /api/describe?lat=&lon=        nearest known address to a point
 *   GET /api/route?from=&via=&to=      route through two or more places
 */

import { join, normalize, resolve } from "node:path";
import { DEFAULT_PORT, REPO_ROOT } from "./config.ts";
import { Pathfinder, PathfinderError } from "./index.ts";
import { formatDistance, formatDuration } from "./units.ts";

const HOME = "/tools/map/pathfinder.html";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: CORS });

function errorResponse(error: unknown): Response {
  if (error instanceof PathfinderError) {
    const status = error.code === "invalid-waypoints" ? 400 : error.code === "no-route" ? 422 : 404;
    return json({ error: error.message, code: error.code }, status);
  }
  console.error(error);
  return json({ error: error instanceof Error ? error.message : "unknown error", code: "internal" }, 500);
}

/** Serve a file from the repository, refusing anything that escapes it. */
async function serveStatic(pathname: string): Promise<Response> {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const target = resolve(join(REPO_ROOT, relative));
  if (!target.startsWith(resolve(REPO_ROOT))) return new Response("Forbidden", { status: 403 });

  const file = Bun.file(target);
  if (await file.exists()) {
    return new Response(file, { headers: { "Cache-Control": "no-cache" } });
  }
  // A directory is not a file as far as Bun.file is concerned, so /tools/map/
  // would 404 without this. Serve its index.html the way any static host does.
  const index = Bun.file(join(target, "index.html"));
  if (await index.exists()) {
    return new Response(index, { headers: { "Cache-Control": "no-cache" } });
  }
  return new Response("Not found", { status: 404 });
}

const port = Number(Bun.env.PORT ?? DEFAULT_PORT);
const openedAt = performance.now();
const pathfinder = await Pathfinder.open();
const stats = pathfinder.stats;
console.log(`loaded ${stats.nodes.toLocaleString()} nodes / ${stats.edges.toLocaleString()} edges and `
  + `${stats.addresses.toLocaleString()} addresses in ${Math.round(performance.now() - openedAt)} ms`);

const server = Bun.serve({
  port,
  idleTimeout: 60,
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return json({ error: "method not allowed" }, 405);

    try {
      switch (url.pathname) {
        case "/":
          return Response.redirect(HOME, 302);

        case "/api/health":
          return json({ ok: true, ...pathfinder.stats });

        case "/api/geocode": {
          const query = url.searchParams.get("q")?.trim();
          if (!query) return json({ error: "q is required" }, 400);
          const limit = Math.min(20, Number(url.searchParams.get("limit") ?? 5) || 5);
          return json({ query, results: pathfinder.suggest(query, limit) });
        }

        case "/api/describe": {
          const lat = Number(url.searchParams.get("lat"));
          const lon = Number(url.searchParams.get("lon"));
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: "lat and lon are required" }, 400);
          return json({ place: pathfinder.describe(lat, lon) });
        }

        case "/api/route": {
          const from = url.searchParams.get("from")?.trim();
          const to = url.searchParams.get("to")?.trim();
          if (!from || !to) return json({ error: "from and to are required" }, 400);
          const via = url.searchParams.getAll("via").map((value) => value.trim());
          if (via.some((value) => !value)) return json({ error: "via waypoints cannot be empty" }, 400);
          const plan = await pathfinder.route([from, ...via, to]);
          return json({
            ...plan,
            readable: {
              distance: formatDistance(plan.distanceMeters),
              duration: formatDuration(plan.durationSeconds),
            },
          });
        }

        default:
          return serveStatic(url.pathname);
      }
    } catch (error) {
      return errorResponse(error);
    }
  },
});

console.log(`pathfinder on http://localhost:${server.port}${HOME}`);
