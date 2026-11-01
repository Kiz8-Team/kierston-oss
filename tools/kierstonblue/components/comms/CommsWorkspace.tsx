"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MessageSquare, Phone, RadioTower, Activity, Users } from "lucide-react";
import { AttentionCurve } from "@/components/comms/AttentionCurve";
import { CarrierRecords } from "@/components/comms/CarrierRecords";
import { CallList, MessageList } from "@/components/comms/MessageList";
import { ThreadList } from "@/components/comms/ThreadList";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { Swatch } from "@/components/Charts";
import { Block, Grid, Section } from "@/components/console/Section";
import { Tile, Tiles } from "@/components/Tiles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { personName } from "@/components/PersonLink";
import { useNames } from "@/components/useNames";
import {
  OUTCOME_COLOR, OUTCOME_LABEL, buildComms, byChannel, byHour, byOutcome,
  channelColor, channelLabel, elapsed, summariseAttention, threadName,
} from "@/lib/comms";
import { num, percent } from "@/lib/format";
import { clock } from "@/lib/day-timeline";
import { useDay } from "@/components/Scope";
import type { PersonComms } from "@/lib/server/comms";
import { cn } from "@/lib/utils";

/** The command to run when a day file predates the layer a block needs. */
const EXPORT = "cd kierston/sim && bun run day --export-day --date";

/**
 * One resident's communications, on one generated day.
 *
 * The page is arranged as the argument the layer makes, from the bottom up. The
 * curve comes first because everything else is sampled from it: when somebody
 * starts a conversation, how long they take to answer one, and whether they pick
 * up the phone are all the same question asked of the same array. The threads
 * and their traffic come next, and the operator's own records come last — not as
 * a footnote, but because they are the smallest of the three and a reader needs
 * to have seen the other two to know what is missing from them.
 */
export function CommsWorkspace() {
  const params = useSearchParams();
  const router = useRouter();
  const names = useNames();
  const requested = Number(params.get("person"));
  const initialPerson = Number.isSafeInteger(requested) && requested >= 0 ? requested : 0;
  const { day: date, days, error: daysError } = useDay();
  const [person, setPerson] = useState(initialPerson);
  const [draft, setDraft] = useState(String(initialPerson));
  const [comms, setComms] = useState<PersonComms | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** One cursor: the figure, the lists and the carrier records all read it. */
  const [cursor, setCursor] = useState(0);
  /** The row the reader last clicked. Cleared as soon as they click anywhere else. */
  const [picked, setPicked] = useState<string | null>(null);
  const [thread, setThread] = useState<number | null>(null);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setThread(null);
    fetch(`/api/days/${encodeURIComponent(date)}/${person}/comms`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (!cancelled) setComms(payload as PersonComms);
      })
      .catch((reason) => {
        if (cancelled) return;
        setComms(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    router.replace(`/comms?date=${encodeURIComponent(date)}&person=${person}`, { scroll: false });
    return () => { cancelled = true; };
  }, [date, person, router]);

  const seek = (minute: number, key: string) => {
    setCursor(minute);
    setPicked((current) => (current === key ? null : key));
  };

  const open = (next: number) => {
    const clean = Math.max(0, Math.floor(next));
    setPerson(clean);
    setDraft(String(clean));
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const next = Number(draft);
    if (Number.isSafeInteger(next) && next >= 0) open(next);
  };

  const view = useMemo(() => comms ? buildComms(comms) : null, [comms]);
  const attention = useMemo(
    () => summariseAttention(comms?.attention.runs ?? []),
    [comms],
  );
  const nameOf = useCallback((id: number) => personName(names, id), [names]);
  const nameOfThread = useCallback(
    (target: Parameters<typeof threadName>[0]) => view ? threadName(target, view, nameOf) : "",
    [view, nameOf],
  );

  const hours = useMemo(() => view ? byHour(view) : [], [view]);
  const platforms = useMemo(() => view ? byChannel(view) : [], [view]);
  const outcomes = useMemo(() => view ? byOutcome(view) : [], [view]);
  const shown = useMemo(
    () => view
      ? view.messages.filter((row) => thread === null || row.thread.index === thread)
      : [],
    [view, thread],
  );
  const shownCalls = useMemo(
    () => view ? view.calls.filter((row) => thread === null || row.thread.index === thread) : [],
    [view, thread],
  );
  const selected = view?.threads.find((item) => item.index === thread) ?? null;
  const answered = shownCalls.filter((row) => row.call.outcome === "answered").length;

  /**
   * What a row is called in the traffic lists.
   *
   * A two-party thread is named by the other person either way round. A group
   * is named by the group, and a message *into* one also names who sent it —
   * without that, thirty rows in a family thread all read as "Family".
   */
  const label = useCallback((
    kind: string, mine: boolean, threadIndex: number, sender: { person: number; displayName: string | null } | undefined,
  ) => {
    const item = view?.threads.find((entry) => entry.index === threadIndex);
    const named = item ? nameOfThread(item) : "";
    if (kind === "dyad" || mine) return named;
    return `${named} — ${counterpartName(sender?.person ?? -1, sender?.displayName ?? null, nameOf)}`;
  }, [view, nameOfThread, nameOf]);

  return (
    <main
      id="content"
      className="relative h-full overflow-auto"
      onClick={(event) => {
        if (!(event.target as HTMLElement).closest("[data-row]")) setPicked(null);
      }}
    >
      <div className="mx-auto max-w-[92rem] p-6 pb-16">
        <header className="max-w-[56rem]">
          <h1 className="m-0 text-[1.35rem] leading-none font-semibold tracking-tight">
            Messages and calls
          </h1>
        </header>

        <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={submit}>
          <label className="grid min-w-[12rem] gap-1.5">
            <span className="text-[0.8rem] font-medium text-muted-foreground">Resident id</span>
            <Input
              inputMode="numeric" min={0} type="number" value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={submit}
            />
          </label>
          <div className="inline-flex overflow-hidden rounded-md border">
            <Button
              type="button" variant="ghost" className="rounded-none border-r"
              disabled={person === 0} onClick={() => open(person - 1)}
            >
              ←
            </Button>
            <Button
              type="button" variant="ghost" className="rounded-none"
              onClick={() => open(person + 1)}
            >
              →
            </Button>
          </div>
          <Button asChild variant="outline">
            <Link href={`/days?date=${encodeURIComponent(date)}&person=${person}`}>Day</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href={`/record?person=${person}`}>Full record</Link>
          </Button>
        </form>

        {!days && !(error ?? daysError) ? <EmptyState title="Loading…" /> : null}
        {days?.length === 0 ? (
          <EmptyState title="No generated days">
            <code>{EXPORT} YYYY-MM-DD</code>
          </EmptyState>
        ) : null}
        {error ?? daysError ? <div className="mt-4"><StatusText state="error">{error ?? daysError}</StatusText></div> : null}

        {comms && view ? (
          <>
            <div className="mt-9 border-t border-border pt-7">
              <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="m-0 text-[1.15rem] leading-none font-semibold tracking-[-0.015em]">
                    {nameOf(person)}
                  </h2>
                  <p className="mt-2 mb-0 text-[0.85rem] text-muted-foreground">
                    Resident <span className="text-[max(0.8rem,0.85em)]">{person}</span>
                    {" "}· {comms.date} · {comms.accounts.length} account
                    {comms.accounts.length === 1 ? "" : "s"} on{" "}
                    {new Set(comms.accounts.map((account) => account.channel)).size} platform
                    {new Set(comms.accounts.map((account) => account.channel)).size === 1 ? "" : "s"}
                  </p>
                </div>
                {loading ? <StatusText state="busy">Loading…</StatusText> : null}
              </div>
              <Tiles>
                <Tile value={num(view.sent)}>messages sent</Tile>
                <Tile value={num(view.received)}>messages received</Tile>
                <Tile value={num(view.placed)}>calls placed</Tile>
                <Tile value={num(view.threads.filter((item) => item.messages + item.calls > 0).length)}>
                  active threads
                </Tile>
                <Tile value={num(view.onCarrier)}>carrier records</Tile>
              </Tiles>
              {comms.messaged ? null : (
                <EmptyState title="No communications layer">
                  <code>{EXPORT} {comms.date}</code>
                </EmptyState>
              )}
            </div>

            <Section
              title={<span className="flex items-center gap-2"><Activity className="size-4" />Attention</span>}
            >
              {comms.attention.known ? (
                <>
                  <AttentionCurve
                    runs={comms.attention.runs}
                    glances={view.glances}
                    minute={cursor}
                    onScrub={(minute) => { setCursor(minute); setPicked(null); }}
                  />
                  <Tiles className="mt-6">
                    <Tile value={percent(attention.meanWaking, 0)}>mean awake</Tile>
                    <Tile value={elapsed(attention.asleep * 60)}>asleep</Tile>
                    <Tile value={attention.peakHour === null ? "—" : clock(attention.peakHour * 60)}>
                      peak hour
                    </Tile>
                    <Tile
                      value={attention.unreachable
                        ? elapsed((attention.unreachable.end - attention.unreachable.start) * 60)
                        : "—"}
                    >
                      longest unreachable
                    </Tile>
                    <Tile value={num(view.glances.length)}>glances</Tile>
                  </Tiles>
                </>
              ) : (
                <EmptyState title="No attention curve">
                  {comms.messaged ? null : <code>{EXPORT} {comms.date}</code>}
                </EmptyState>
              )}
            </Section>

            <Section
              title={<span className="flex items-center gap-2"><MessageSquare className="size-4" />Traffic</span>}
              meta={`${num(view.messages.length)} messages · ${num(view.calls.length)} calls`}
            >
              <Grid min="20rem">
                <Block title="Messages by hour">
                  <HourChart hours={hours} />
                </Block>
                <Block title="Platforms">
                  <Shares
                    rows={platforms.map((row) => ({
                      label: channelLabel(row.channel),
                      value: row.value,
                      color: channelColor(row.channel),
                    }))}
                  />
                </Block>
                <Block title="Call attempts">
                  <Shares
                    rows={outcomes.map((row) => ({
                      label: OUTCOME_LABEL[row.outcome] ?? row.outcome,
                      value: row.value,
                      color: OUTCOME_COLOR[row.outcome] ?? "#8a97a3",
                    }))}
                  />
                </Block>
              </Grid>
            </Section>

            <Section
              title={<span className="flex items-center gap-2"><Users className="size-4" />Threads</span>}
              meta={selected ? nameOfThread(selected) : undefined}
            >
              <Grid min="24rem">
                <Block title="Threads" meta={`${num(view.threads.length)}`}>
                  <ThreadList
                    threads={view.threads}
                    selected={thread}
                    onSelect={setThread}
                    name={nameOfThread}
                  />
                </Block>
                <Block
                  title={selected ? nameOfThread(selected) : "Messages"}
                  meta={`${num(shown.length)} message${shown.length === 1 ? "" : "s"}`}
                >
                  <MessageList
                    rows={shown}
                    active={picked}
                    onSeek={seek}
                    name={(row) => label(row.thread.kind, row.mine, row.thread.index, row.from)}
                  />
                </Block>
              </Grid>
            </Section>

            <Section
              title={<span className="flex items-center gap-2"><Phone className="size-4" />Calls</span>}
              meta={`${num(answered)} of ${num(shownCalls.length)} answered`}
            >
              <CallList
                rows={shownCalls}
                active={picked}
                onSeek={seek}
                name={(row) => label(row.thread.kind, row.mine, row.thread.index, row.from)}
              />
            </Section>

            <Section
              title={<span className="flex items-center gap-2"><RadioTower className="size-4" />Carrier records</span>}
              meta={`${num(view.onCarrier)} of ${num(view.sent)} sent messages`}
            >
              <Grid min="24rem">
                <CarrierRecords view={view} active={picked} onSeek={seek} />
              </Grid>
            </Section>
          </>
        ) : loading && days?.length ? (
          <EmptyState title="Loading…" />
        ) : null}
      </div>
    </main>
  );
}

/**
 * Who sent a message, when it was not the person being read.
 *
 * The platform's display name is shown only where the account belongs to nobody
 * in the population — an absent parent, a family left behind. For everybody else
 * the identity file's name is used, because a display name is what the platform
 * shows and is not reliably the real one, which is the distinction this whole
 * layer exists to make somebody work for.
 */
function counterpartName(
  person: number, displayName: string | null, nameOf: (person: number) => string,
): string {
  if (person >= 0) return nameOf(person);
  return displayName ?? "Off-map contact";
}

/**
 * Sent and received per hour, stacked.
 *
 * Stacked rather than side by side because the reading is the shape of the day
 * as a whole and the split within an hour is secondary — two thin bars per hour
 * makes forty-eight bars, and at that width neither series has a shape left.
 */
function HourChart({ hours }: { hours: { hour: number; sent: number; received: number }[] }) {
  const max = hours.reduce((acc, row) => Math.max(acc, row.sent + row.received), 0) || 1;
  return (
    <div className="grid gap-[0.3rem]">
      <div className="flex h-[5.5rem] items-end gap-[2px] border-b border-border">
        {hours.map((row) => (
          <span
            key={row.hour}
            className="flex h-full min-w-0 flex-1 flex-col justify-end"
            title={`${String(row.hour).padStart(2, "0")}:00 — ${row.sent} sent, ${row.received} received`}
          >
            <i
              className="w-full rounded-t-[4px] bg-chart-1"
              style={{ height: `${(row.sent / max) * 100}%` }}
            />
            <i
              className={cn("w-full bg-chart-3", row.sent === 0 && "rounded-t-[4px]")}
              style={{ height: `${(row.received / max) * 100}%` }}
            />
          </span>
        ))}
      </div>
      <div className="flex gap-[2px] text-[0.7rem] text-muted-foreground tabular-nums">
        {hours.map((row) => (
          <span key={row.hour} className="min-w-0 flex-1">
            {row.hour % 6 === 0 ? `${String(row.hour).padStart(2, "0")}:00` : ""}
          </span>
        ))}
      </div>
      <div className="flex gap-[0.85rem] text-[0.8rem] text-muted-foreground">
        <span><Swatch color="var(--chart-1)" />sent</span>
        <span><Swatch color="var(--chart-3)" />received</span>
      </div>
    </div>
  );
}

/**
 * A share list in the colours the rest of the page uses for the same thing.
 *
 * `BarList` in `Charts.tsx` draws every bar in the sequential hue, which is
 * right for a distribution over bands and wrong here: the platform colours and
 * the outcome colours are already the page's vocabulary, and a grey bar beside a
 * green legend dot makes the reader do the join twice.
 */
function Shares({ rows }: { rows: { label: string; value: number; color: string }[] }) {
  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const max = rows.reduce((acc, row) => Math.max(acc, row.value), 0) || 1;
  if (!rows.length) {
    return <p className="text-[0.85rem] text-muted-foreground">None</p>;
  }
  return (
    <div>
      {rows.map((row) => (
        <div
          key={row.label}
          className="mt-[0.35rem] grid grid-cols-[6.5rem_1fr_4.5rem] items-center gap-2 first-of-type:mt-0"
          title={`${num(row.value)} of ${num(total)}`}
        >
          <span className="truncate text-[0.8rem] text-muted-foreground">{row.label}</span>
          <span className="block h-[0.62rem] overflow-hidden rounded-[4px] bg-[var(--grid-line)]">
            <i
              className="block h-full rounded-[4px]"
              style={{ width: `${(row.value / max) * 100}%`, background: row.color }}
            />
          </span>
          <span className="text-right text-[0.8rem] tabular-nums">
            {num(row.value)} · {percent(row.value / (total || 1), 0)}
          </span>
        </div>
      ))}
    </div>
  );
}
