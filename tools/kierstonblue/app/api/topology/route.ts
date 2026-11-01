import { packedTopology } from "@/lib/server/topology";

/** The road network as packed typed arrays. See lib/server/topology.ts. */
export async function GET() {
  try {
    const packed = await packedTopology();
    return new Response(new Uint8Array(packed), {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(packed.length),
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "could not pack topology" },
      { status: 500 },
    );
  }
}
