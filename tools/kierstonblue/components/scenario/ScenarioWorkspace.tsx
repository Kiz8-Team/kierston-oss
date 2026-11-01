"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { PersonDiffView } from "@/components/scenario/PersonDiff";
import { PersonLink } from "@/components/PersonLink";
import { Block, Grid, Section } from "@/components/console/Section";
import { Tile, Tiles } from "@/components/Tiles";
import { Badge } from "@/components/ui/badge";
import { NativeSelect } from "@/components/ui/native-select";
import { useNames } from "@/components/useNames";
import { clock } from "@/lib/day-timeline";
import { bytes, num } from "@/lib/format";
import type { ScenarioAction } from "@/lib/server/kday";
import type { ScenarioDetail, ScenarioPersonDiff, ScenarioSummary } from "@/lib/server/scenario";
import { cn } from "@/lib/utils";

/**
 * The scenario console.
 *
 * The comparison is the page. Everything else — bindings, digests, what the
 * engine realized — sits under it as reference, because the question that
 * brings anyone here is what the scenario did to the day.
 *
 * A delta with no merged `.bin` cannot be compared, so the selector prefers
 * one that can and marks the ones that cannot.
 */

const CODE = "font-sans text-[max(0.8rem,0.85em)]";

function KeyValue({ label, children, mono = false }: {
  label: string;
  children: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="border-t border-border/60 py-1.5 first:border-0">
      <dt className="micro text-[0.62rem]">{label}</dt>
      <dd className={cn("m-0 mt-0.5 text-[0.85rem]", mono && "text-[0.78rem] break-all")}>
        {children}
      </dd>
    </div>
  );
}

function ActionLine({ action }: { action: ScenarioAction }) {
  const result = action.result;
  const detail = result ? [
    result.mode,
    result.channel,
    result.outcome,
    result.arrival !== result.start ? `arrives ${clock(result.arrival)}` : null,
    result.departure !== result.arrival ? `leaves ${clock(result.departure)}` : null,
    result.legs?.length ? `${result.legs.length} leg${result.legs.length > 1 ? "s" : ""}` : null,
    result.transactions?.length ? `tx ${result.transactions.join(", ")}` : null,
    result.decline,
  ].filter(Boolean).join(" · ") : null;

  return (
    <li className="grid grid-cols-[4.2rem_1fr] items-baseline gap-3 border-t border-border/60 py-1.5 first:border-0">
      <span className="text-[0.85rem] tabular-nums">{result ? clock(result.start) : "—"}</span>
      <span className="min-w-0 text-[0.85rem] leading-tight">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <strong className="font-medium">{action.id}</strong>
          <Badge variant="secondary">{action.kind}</Badge>
          {result?.approved === false ? <Badge variant="destructive">declined</Badge> : null}
        </span>
        <span className="mt-px block text-[0.85rem] text-muted-foreground">
          {detail || "no result"}
        </span>
      </span>
    </li>
  );
}

export function ScenarioWorkspace() {
  const params = useSearchParams();
  const router = useRouter();
  const names = useNames();

  const [list, setList] = useState<ScenarioSummary[] | null>(null);
  const [slug, setSlug] = useState(params.get("scenario") ?? "");
  const [detail, setDetail] = useState<ScenarioDetail | null>(null);
  const [person, setPerson] = useState<number | null>(() => {
    const value = Number(params.get("person"));
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  });
  const [diff, setDiff] = useState<ScenarioPersonDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    fetch("/api/scenarios")
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        return payload.scenarios as ScenarioSummary[];
      })
      .then((scenarios) => {
        setList(scenarios);
        // Land on a delta that can actually be compared. Newest-first put a
        // never-merged delta at the top, and the page opened on its own
        // instructions rather than on a day.
        const comparable = scenarios.find((row) => row.materialized);
        setSlug((current) => current || comparable?.slug || scenarios[0]?.slug || "");
      })
      .catch((cause: Error) => setError(cause.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!slug) return;
    let live = true;
    setLoading(true);
    setError(null);
    fetch(`/api/scenarios/${encodeURIComponent(slug)}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        return payload as ScenarioDetail;
      })
      .then((payload) => {
        if (!live) return;
        setDetail(payload);
        // Keep a selected person only if this scenario touched them. Prefer
        // one whose rows actually moved over one that only received a call.
        setPerson((current) => {
          if (current !== null && payload.affectedPeople.some((row) => row.person === current)) {
            return current;
          }
          const moved = payload.affectedPeople.find((row) => row.counts
            && Object.values(row.counts).some(([before, after]) => before !== after));
          return moved?.person ?? payload.affectedPeople[0]?.person ?? null;
        });
      })
      .catch((cause: Error) => { if (live) { setError(cause.message); setDetail(null); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [slug]);

  useEffect(() => {
    if (!slug || person === null || !detail?.materialized) { setDiff(null); return; }
    let live = true;
    setDiffLoading(true);
    fetch(`/api/scenarios/${encodeURIComponent(slug)}/${person}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        return payload as ScenarioPersonDiff;
      })
      .then((payload) => { if (live) setDiff(payload); })
      .catch(() => { if (live) setDiff(null); })
      .finally(() => { if (live) setDiffLoading(false); });
    return () => { live = false; };
  }, [slug, person, detail?.materialized]);

  useEffect(() => {
    const next = new URLSearchParams();
    if (slug) next.set("scenario", slug);
    if (person !== null) next.set("person", String(person));
    router.replace(`/scenarios?${next.toString()}`, { scroll: false });
  }, [slug, person, router]);

  const truth = detail?.truth ?? null;
  const chosen = useMemo(
    () => detail?.affectedPeople.find((row) => row.person === person) ?? null,
    [detail, person],
  );

  const nameOf = useCallback(
    (id: number) => (names?.knows(id) ? names.shortName(id) : `Resident ${id}`),
    [names],
  );

  const mergeCommand = detail
    ? `bun run scenarios merge --input kierston/sim_outputs/day_${detail.date}.bin`
      + ` --delta kierston/sim_outputs/${detail.slug}.kdiff`
      + ` --output kierston/sim_outputs/${detail.slug}.bin`
    : "";

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[86rem] p-6 pb-16">
        <header className="max-w-[56rem]">
          <h1 className="m-0 text-[1.35rem] leading-none font-semibold tracking-tight">
            Scenarios
          </h1>
        </header>

        <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={(event) => event.preventDefault()}>
          <label className="grid min-w-[20rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Delta</span>
            <NativeSelect
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              disabled={!list?.length}
            >
              {list?.map((row) => (
                <option key={row.slug} value={row.slug}>
                  {row.name ? `${row.name} · ` : ""}{row.slug}
                  {row.materialized ? "" : " — not merged"}
                </option>
              ))}
            </NativeSelect>
          </label>
          {loading ? <StatusText state="busy">Loading…</StatusText> : null}
        </form>

        {list?.length === 0 ? (
          <EmptyState title="No scenario deltas">
            <span className={CODE}>
              bun run scenarios create --scenario kierston_scenarios/scenarios/demo/coffee.ts
            </span>
          </EmptyState>
        ) : null}
        {error ? <div className="mt-4"><StatusText state="error">{error}</StatusText></div> : null}

        {detail ? (
          <>
            <Section
              title={truth?.name ?? detail.slug}
              meta={detail.affectedPeople.length
                ? `${detail.affectedPeople.length} affected · ${detail.date}`
                : detail.date}
            >
              {detail.base && !detail.base.matches ? (
                <div className="mb-5">
                  <StatusText state="error">
                    Base digest mismatch · day_{detail.date}.bin
                  </StatusText>
                </div>
              ) : null}
              {!detail.base ? (
                <div className="mb-5">
                  <StatusText state="error">No base day_{detail.date}.bin</StatusText>
                </div>
              ) : null}

              {!detail.materialized ? (
                <EmptyState title="Not merged">
                  <span className={CODE}>{mergeCommand}</span>
                </EmptyState>
              ) : (
                <>
                  <div className="flex flex-wrap gap-1.5">
                    {detail.affectedPeople.map((row) => {
                      const moved = row.counts
                        ? Object.values(row.counts).filter(([a, b]) => a !== b).length
                        : 0;
                      return (
                        <button
                          key={row.person}
                          type="button"
                          onClick={() => setPerson(row.person)}
                          className={cn(
                            "border border-border px-2.5 py-1 text-left text-[0.85rem] leading-tight",
                            "cursor-pointer hover:bg-accent",
                            row.person === person && "bg-accent shadow-[inset_2px_0_0_var(--primary)]",
                          )}
                        >
                          <span className="block font-medium">{nameOf(row.person)}</span>
                          <span className="block text-[0.85rem] text-muted-foreground">
                            {moved ? `${moved} table${moved > 1 ? "s" : ""} changed` : "unchanged"}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {chosen?.reasons.length ? (
                    <p className="mt-3 mb-0 text-[0.85rem] text-muted-foreground">
                      {chosen.reasons.join(" · ")}
                    </p>
                  ) : null}

                  <div className="mt-6">
                    {diffLoading ? <StatusText state="busy">Loading…</StatusText> : null}
                    {diff ? <PersonDiffView diff={diff} /> : null}
                    {!diff && !diffLoading && person !== null ? (
                      <StatusText state="error">No diff · resident {person}</StatusText>
                    ) : null}
                  </div>
                </>
              )}
            </Section>

            {truth ? (
              <Section title="Actions" meta={`${truth.actions.length} realized`}>
                <ol className="m-0 grid list-none gap-0 p-0">
                  {truth.actions.map((action) => (
                    <ActionLine key={action.id} action={action} />
                  ))}
                </ol>
              </Section>
            ) : null}

            <Section title="Delta" meta={`${bytes(detail.deltaBytes)} · KDIF v1`}>
              <Tiles>
                <Tile value={bytes(detail.deltaBytes)}>On disk</Tile>
                <Tile value={detail.storage.ratio ? `${Math.round(detail.storage.ratio)}×` : "—"}>
                  Compression
                </Tile>
                <Tile value={detail.storage.columnsTotal
                  ? `${detail.columnsChanged}/${detail.storage.columnsTotal}`
                  : num(detail.columnsChanged)}>
                  Columns changed
                </Tile>
                <Tile value={detail.seed ?? "—"}>Seed</Tile>
              </Tiles>

              <Grid className="mt-7" min="20rem">
                <Block title="Binding">
                  <dl className="m-0">
                    <KeyValue label="Base day">day_{detail.date}.bin</KeyValue>
                    <KeyValue label="Base digest" mono>{detail.baseHash.slice(0, 32)}…</KeyValue>
                    {truth?.provenance?.engine ? (
                      <KeyValue label="Engine" mono>{truth.provenance.engine.slice(0, 32)}…</KeyValue>
                    ) : null}
                    <KeyValue label="Merged day">
                      {detail.materialized ? bytes(detail.materialized.bytes) : "none"}
                    </KeyValue>
                  </dl>
                </Block>

                <Block title="Roles" meta={truth ? `${Object.keys(truth.actors).length} bound` : undefined}>
                  {truth ? (
                    <dl className="m-0">
                      {Object.entries(truth.actors).map(([role, id]) => (
                        <KeyValue key={role} label={role}>
                          <PersonLink names={names} person={id} />
                        </KeyValue>
                      ))}
                      {Object.entries(truth.places).map(([role, venue]) => (
                        <KeyValue key={role} label={role} mono>{venue}</KeyValue>
                      ))}
                    </dl>
                  ) : (
                    <p className="m-0 text-[0.85rem] text-muted-foreground">No base day</p>
                  )}
                </Block>
              </Grid>
            </Section>
          </>
        ) : null}
      </div>
    </main>
  );
}
