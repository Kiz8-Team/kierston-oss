import { readScenarioPerson } from "@/lib/server/scenario";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string; person: string }> },
) {
  const { slug, person: rawPerson } = await params;
  const person = Number(rawPerson);
  if (!Number.isSafeInteger(person) || person < 0) {
    return Response.json({ error: "invalid resident id" }, { status: 400 });
  }
  try {
    const diff = await readScenarioPerson(slug, person);
    return diff
      ? Response.json(diff)
      : Response.json(
        { error: `no base day for ${slug}` },
        { status: 404 },
      );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
