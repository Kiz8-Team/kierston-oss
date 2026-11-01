import { listScenarios } from "@/lib/server/scenario";

export async function GET() {
  try {
    return Response.json({ scenarios: await listScenarios() });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
