"use client";

import { Minus, Plus } from "lucide-react";

import { Block, Grid } from "@/components/console/Section";
import { Tile, Tiles } from "@/components/Tiles";
import { clock, duration } from "@/lib/day-timeline";
import { num, usdExact } from "@/lib/format";
import { diffPersonDay, tally, type ChangeKind, type DiffRow } from "@/lib/scenario-diff";
import type { DayMovementLeg, DayScheduleEntry, DayTransaction } from "@/lib/server/day";
import type { ScenarioPersonDiff } from "@/lib/server/scenario";
import { cn } from "@/lib/utils";

/**
 * One person's day, base against scenario.
 *
 * One chronological run rather than two columns: a day is forty rows and a
 * scenario changes three, so two full columns would be two screens of the same
 * text. Added and removed rows are marked in the margin, unchanged ones dimmed
 * — and kept, because they are the evidence the scenario stayed local.
 */

const MARK: Record<ChangeKind, { sign: string; className: string }> = {
  added: { sign: "+", className: "text-[var(--success)]" },
  removed: { sign: "−", className: "text-destructive" },
  same: { sign: "", className: "text-muted-foreground" },
};

function Row({ kind, children }: { kind: ChangeKind; children: React.ReactNode }) {
  const mark = MARK[kind];
  return (
    <li
      className={cn(
        "grid grid-cols-[1.1rem_1fr] items-baseline gap-1.5 border-t border-border/50 px-1 py-1",
        "first:border-0 leading-tight",
        kind === "same" && "text-muted-foreground",
        kind === "added" && "bg-[var(--success)]/[0.07]",
        kind === "removed" && "bg-destructive/[0.07]",
      )}
    >
      <span aria-hidden className={cn("text-center text-[0.8rem]", mark.className)}>
        {mark.sign}
      </span>
      <span className="min-w-0">{children}</span>
    </li>
  );
}

/** The count in a block's head: what this table gained and lost. */
function changeMeta<T>(rows: DiffRow<T>[]): string {
  const counts = tally(rows);
  if (!counts.added && !counts.removed) return `${num(counts.same)} unchanged`;
  const parts: string[] = [];
  if (counts.added) parts.push(`+${counts.added}`);
  if (counts.removed) parts.push(`−${counts.removed}`);
  return `${parts.join(" ")} · ${num(counts.same)} unchanged`;
}

const scheduleLine = (entry: DayScheduleEntry) => (
  <>
    <span className="tabular-nums">{clock(entry.start)}–{clock(entry.end)}</span>{" "}
    <strong className="font-medium">{entry.kind}</strong>
    {entry.label ? <span> · {entry.label}</span> : null}
    {entry.where ? <span className="text-muted-foreground"> · {entry.where}</span> : null}
  </>
);

const legLine = (leg: DayMovementLeg) => (
  <>
    <span className="tabular-nums">{clock(leg.depart)}–{clock(leg.arrive)}</span>{" "}
    <strong className="font-medium">{leg.mode}</strong>
    <span> · {leg.purpose}</span>
    <span className="text-muted-foreground">
      {" "}· {leg.kilometres.toFixed(2)} km · {duration(leg.arrive - leg.depart)}
    </span>
    {leg.to.label ? <span> → {leg.to.label}</span> : null}
  </>
);

const transactionLine = (tx: DayTransaction) => (
  <>
    <span className="tabular-nums">{clock(tx.minute)}</span>{" "}
    <strong className="font-medium tabular-nums">{usdExact(tx.amount)}</strong>
    <span> · {tx.reason}</span>
    {tx.merchant ? <span> · {tx.merchant}</span> : null}
    {!tx.approved ? (
      <span className="text-destructive"> · declined{tx.decline ? ` (${tx.decline})` : ""}</span>
    ) : null}
  </>
);

function DiffList<T>({ rows, line }: { rows: DiffRow<T>[]; line: (row: T) => React.ReactNode }) {
  if (!rows.length) {
    return <p className="m-0 text-[0.85rem] text-muted-foreground">—</p>;
  }
  return (
    <ol className="m-0 grid list-none gap-0 p-0 text-[0.85rem]">
      {rows.map((row, index) => (
        <Row key={index} kind={row.kind}>{line((row.after ?? row.before)!)}</Row>
      ))}
    </ol>
  );
}

export function PersonDiffView({ diff }: { diff: ScenarioPersonDiff }) {
  const compared = diffPersonDay(diff.base, diff.scenario);
  const [beforeKm, afterKm] = compared.distance;

  if (!diff.scenario) {
    return <p className="m-0 text-[0.85rem] text-muted-foreground">Not merged</p>;
  }

  return (
    <div>
      <Tiles className="mb-6">
        <Tile value={`${afterKm.toFixed(1)} km`}>
          Distance{beforeKm !== afterKm ? ` · base ${beforeKm.toFixed(1)}` : ""}
        </Tile>
        <Tile value={num(compared.legs.filter((row) => row.kind !== "same").length)}>
          Legs changed
        </Tile>
        <Tile value={num(compared.transactions.filter((row) => row.kind !== "same").length)}>
          Charges changed
        </Tile>
        <Tile value={compared.balanceShift === null ? "—" : usdExact(compared.balanceShift)}>
          Balance shift
        </Tile>
      </Tiles>

      <Grid min="24rem">
        <Block title="Schedule" meta={changeMeta(compared.schedule)}>
          <DiffList rows={compared.schedule} line={scheduleLine} />
        </Block>
        <Block title="Movement" meta={changeMeta(compared.legs)}>
          <DiffList rows={compared.legs} line={legLine} />
        </Block>
        <Block wide title="Ledger" meta={changeMeta(compared.transactions)}>
          <DiffList rows={compared.transactions} line={transactionLine} />
        </Block>
      </Grid>

      <p className="mt-5 flex items-center gap-4 text-[0.85rem] text-muted-foreground">
        <span className="flex items-center gap-1">
          <Plus className="size-3 text-[var(--success)]" />scenario only
        </span>
        <span className="flex items-center gap-1">
          <Minus className="size-3 text-destructive" />base only
        </span>
      </p>
    </div>
  );
}
