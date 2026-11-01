import { readFile } from "node:fs/promises";
import type { LabelPayload } from "@/lib/labels";
import { datasetPath } from "@/lib/server/repo";

/**
 * The PUMS code books, reduced to the three dictionaries this app displays.
 *
 * Everything downstream of the population carries codes: OCCP 3870, INDP 7680,
 * JWTRNS 01. The books that say what they mean are 460 kB of Census metadata
 * covering 517 variables, so they are read once here and served as ~60 kB of
 * code → label — small enough to fetch alongside a page rather than being a
 * dataset of its own.
 */

/** Keyed on the code book, which belongs to the city build being viewed. */
const cached = new Map<string, { payload: LabelPayload; json: string }>();

async function build(codebookPath: string): Promise<{ payload: LabelPayload; json: string }> {
  const [mapping, codebook] = await Promise.all([
    readFile(await datasetPath("occupations"), "utf8").then(JSON.parse),
    readFile(codebookPath, "utf8").then(JSON.parse),
  ]);

  const variables = codebook.variables ?? {};
  const items = (name: string): Record<string, string> =>
    (variables[name]?.values?.item ?? {}) as Record<string, string>;

  const occupation: LabelPayload["occupation"] = {};
  for (const [code, entry] of Object.entries(mapping.occupations ?? {})) {
    const record = entry as { label: string; major_group: string };
    occupation[code] = [record.label, record.major_group];
  }
  // OCCP codes the CPS appendix does not carry still deserve a name, even the
  // sector-prefixed one the codebook gives.
  for (const [code, label] of Object.entries(items("OCCP"))) {
    if (!occupation[code] && /^\d+$/.test(code)) occupation[code] = [label, ""];
  }

  const occupationGroups: LabelPayload["occupationGroups"] = {};
  for (const group of (mapping.major_groups ?? []) as { code: string; label: string }[]) {
    occupationGroups[group.code] = group.label;
  }

  const industry: LabelPayload["industry"] = {};
  for (const [code, label] of Object.entries(items("INDP"))) {
    if (/^\d+$/.test(code)) industry[code] = label;
  }

  const payload: LabelPayload = {
    occupation,
    occupationGroups,
    industry,
    transport: items("JWTRNS"),
    // SCHG. Sixteen codes, so it costs nothing to carry, and it is the only
    // way to turn the grade on an enrollment row into "Grade 4".
    grade: items("SCHG"),
  };
  return { payload, json: JSON.stringify(payload) };
}

export async function GET() {
  try {
    const codebookPath = await datasetPath("codebook");
    let entry = cached.get(codebookPath);
    if (!entry) cached.set(codebookPath, entry = await build(codebookPath));
    return new Response(entry.json, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "code books unreadable" },
      { status: 500 },
    );
  }
}
