"use client";

import { ArrowDownLeft, ArrowUpRight, PhoneIncoming, PhoneOutgoing } from "lucide-react";
import {
  OUTCOME_COLOR, OUTCOME_LABEL, channelColor, channelLabel, elapsed, stamp, wire,
  type CallRow, type MessageRow,
} from "@/lib/comms";
import { cn } from "@/lib/utils";

const ROW = "grid w-full grid-cols-[4.6rem_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 "
  + "rounded-sm px-1.5 py-1.5 text-left leading-tight hover:bg-accent";

const CURRENT = "bg-accent ring-1 ring-primary/30";

const LIST = "grid max-h-[26rem] list-none gap-0 overflow-auto p-0";

/** The line under a row's name. Wraps rather than truncating. */
const SECOND = "mt-0.5 block text-[0.8rem] leading-[1.45] text-pretty text-muted-foreground";

/** Which platform a row travelled over, at the right-hand end of it. */
function Platform({ channel }: { channel: string }) {
  return (
    <span className="mt-[0.15rem] flex shrink-0 items-center gap-1.5 text-[0.78rem] text-muted-foreground">
      <span
        aria-hidden
        className="inline-block size-[0.45rem] rounded-[2px]"
        style={{ background: channelColor(channel) }}
      />
      {channelLabel(channel)}
    </span>
  );
}

/**
 * How many rows are drawn before the list stops.
 *
 * Not a display nicety: the day cursor is shared with the figure above, so every
 * frame of a drag re-renders whatever is on screen, and the busiest resident in
 * this city sent two and a half thousand messages. Four hundred rows is more
 * than anybody reads in one scroll, and the remainder is reachable by picking a
 * thread — the count says how many are being held back so the cap is never
 * mistaken for the end of the day.
 */
const LIMIT = 400;

/**
 * The day's messages, in the order they happened rather than by thread.
 *
 * One list for both directions, because the interleaving is the point: a reply
 * forty seconds after the message it answers and a reply four hours after it are
 * the same two rows in a per-thread view and completely different days in this
 * one. Where a message answers another the gap is named on the row, since that
 * gap is the whole output of the reply model.
 */
export function MessageList({ rows, active, onSeek, name }: {
  rows: MessageRow[];
  /** The row the reader last picked, or null once they have clicked away. */
  active: string | null;
  onSeek: (minute: number, key: string) => void;
  name: (row: MessageRow) => string;
}) {
  if (!rows.length) {
    return (
      <p className="text-[0.85rem] text-muted-foreground">No messages</p>
    );
  }
  return (
    <ol className={LIST}>
      {rows.slice(0, LIMIT).map((row) => {
        const minute = Math.floor(row.message.at / 60);
        const carrier = row.carrier.length;
        const key = `message:${row.message.index}`;
        return (
          <li key={row.message.index} className="border-t border-border first:border-0">
            <button
              type="button"
              data-row
              className={cn(ROW, key === active && CURRENT)}
              onClick={() => onSeek(minute, key)}
            >
              <span className="mt-[0.1rem] tabular-nums text-[0.85rem] font-semibold">
                {stamp(row.message.at)}
              </span>
              <span className="min-w-0">
                <span className="flex items-start gap-1.5">
                  {row.mine
                    ? <ArrowUpRight className="mt-[0.05rem] size-3.5 shrink-0 text-[var(--success)]" />
                    : <ArrowDownLeft className="mt-[0.05rem] size-3.5 shrink-0 text-[var(--accent-ink)]" />}
                  <strong className="min-w-0 truncate text-[0.88rem]">{name(row)}</strong>
                </span>
                <span className={SECOND}>
                  {[
                    row.mine ? "sent" : "received",
                    row.message.kind === "text" ? null : row.message.kind,
                    wire(row.message.kind, row.message.bytes),
                    row.latency !== null ? `reply +${elapsed(row.latency)}` : null,
                    // What an operator would hold for this row, and what it
                    // would not. Six of the nine platforms leave nothing.
                    carrier ? `${carrier} carrier row${carrier === 1 ? "" : "s"}` : "no carrier row",
                  ].filter(Boolean).join(" · ")}
                </span>
              </span>
              <Platform channel={row.thread.channel} />
            </button>
          </li>
        );
      })}
      {rows.length > LIMIT ? (
        <li className="border-t border-border px-1.5 py-2 text-[0.85rem] text-muted-foreground">
          {rows.length - LIMIT} more
        </li>
      ) : null}
    </ol>
  );
}

/**
 * Every call *attempt*, answered or not.
 *
 * The unanswered ones are the majority and they are the reason this list is not
 * a list of conversations: a ring-out says the callee was away from the phone at
 * that minute, which is a reading of the curve above and the single most useful
 * thing in a set of call records.
 */
export function CallList({ rows, active, onSeek, name }: {
  rows: CallRow[];
  active: string | null;
  onSeek: (minute: number, key: string) => void;
  name: (row: CallRow) => string;
}) {
  if (!rows.length) {
    return <p className="text-[0.85rem] text-muted-foreground">No calls</p>;
  }
  return (
    <ol className={LIST}>
      {rows.map((row) => {
        const minute = Math.floor(row.call.at / 60);
        const key = `call:${row.call.index}`;
        return (
          <li key={row.call.index} className="border-t border-border first:border-0">
            <button
              type="button"
              data-row
              className={cn(ROW, key === active && CURRENT)}
              onClick={() => onSeek(minute, key)}
            >
              <span className="mt-[0.1rem] tabular-nums text-[0.85rem] font-semibold">
                {stamp(row.call.at)}
              </span>
              <span className="min-w-0">
                <span className="flex items-start gap-1.5">
                  {row.mine
                    ? <PhoneOutgoing className="mt-[0.05rem] size-3.5 shrink-0 text-[var(--success)]" />
                    : <PhoneIncoming className="mt-[0.05rem] size-3.5 shrink-0 text-[var(--accent-ink)]" />}
                  <strong className="min-w-0 truncate text-[0.88rem]">{name(row)}</strong>
                  <span
                    className="shrink-0 text-[0.78rem] font-medium"
                    style={{ color: OUTCOME_COLOR[row.call.outcome] }}
                  >
                    {OUTCOME_LABEL[row.call.outcome] ?? row.call.outcome}
                  </span>
                </span>
                <span className={SECOND}>
                  {[
                    row.mine ? "dialled" : "received",
                    `ring ${elapsed(row.call.ring)}`,
                    row.call.duration ? `talk ${elapsed(row.call.duration)}` : null,
                    row.answers ? `returns ${stamp(row.answers.at)}` : null,
                    row.record ? "carrier record" : "app only",
                  ].filter(Boolean).join(" · ")}
                </span>
              </span>
              <Platform channel={row.thread.channel} />
            </button>
          </li>
        );
      })}
    </ol>
  );
}
