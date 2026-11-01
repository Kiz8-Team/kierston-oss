import { readMeetingIndex, type MeetingRow } from "@/lib/server/meetings";

/** How many rows one request hands back. The list is virtual-scrolled below it. */
const PAGE = 300;

type Sort = "start" | "party-desc" | "length-desc";

function matches(row: MeetingRow, query: string, person: number | null): boolean {
  if (person !== null && row.party.some((party) => party.person === person)) return true;
  if (!query) return person === null;
  return row.key.toLowerCase().includes(query)
    || row.purpose.toLowerCase().includes(query)
    || (row.venue?.toLowerCase().includes(query) ?? false);
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ date: string }> },
) {
  const { date } = await params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return Response.json({ error: "invalid date" }, { status: 400 });
  }
  try {
    const index = await readMeetingIndex(date);
    if (!index) return Response.json({ error: `no day file for ${date}` }, { status: 404 });

    const url = new URL(request.url);
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase();
    // A bare number is read as a resident id as well as as text, because the
    // question people arrive with is "what did 41207 go out to".
    const person = /^\d+$/.test(query) ? Number(query) : null;
    const kind = url.searchParams.get("kind") ?? "any";
    const purpose = url.searchParams.get("purpose") ?? "any";
    const least = Number(url.searchParams.get("least") ?? 2);
    const sort = (url.searchParams.get("sort") ?? "start") as Sort;
    const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));

    const rows = index.meetings.filter((row) =>
      (kind === "any" || row.kind === kind)
      && (purpose === "any" || row.purpose === purpose)
      && row.party.length >= (Number.isFinite(least) ? least : 2)
      && (!query || matches(row, query, person)));

    const ordered = [...rows].sort((a, b) => {
      if (sort === "party-desc") return b.party.length - a.party.length || a.start - b.start;
      if (sort === "length-desc") return (b.end - b.start) - (a.end - a.start) || a.start - b.start;
      return a.start - b.start || a.index - b.index;
    });

    return Response.json({
      date: index.date,
      total: index.meetings.length,
      matched: ordered.length,
      offset,
      meetings: ordered.slice(offset, offset + PAGE),
      kinds: [...new Set(index.meetings.map((row) => row.kind))].sort(),
      purposes: [...new Set(index.meetings.map((row) => row.purpose))].sort(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: /ENOENT/.test(message) ? 404 : 500 });
  }
}
