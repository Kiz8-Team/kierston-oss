import { readScenario } from "@/lib/server/scenario";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  try {
    const scenario = await readScenario(slug);
    return scenario
      ? Response.json(scenario)
      : Response.json({ error: `no scenario delta named ${slug}` }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
