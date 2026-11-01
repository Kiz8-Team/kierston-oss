"use client";

import { Block } from "@/components/console/Section";
import { cellOf, elapsed, lineOf, stamp, type CommsView } from "@/lib/comms";
import { num } from "@/lib/format";
import { cn } from "@/lib/utils";

const LIST = "grid max-h-[22rem] list-none gap-0 overflow-auto p-0";

const ROW = "grid w-full grid-cols-[4.6rem_minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 "
  + "rounded-sm px-1.5 py-1.5 text-left leading-tight hover:bg-accent";

const CURRENT = "bg-accent ring-1 ring-primary/30";

/** Wrapped, not truncated — see the same constant in `MessageList`. */
const SECOND = "mt-0.5 block text-[0.8rem] leading-[1.45] text-pretty text-muted-foreground";

/** As in the message list, and for the same reason — see `MessageList`. */
const LIMIT = 400;

/**
 * What the operator would hold, which is less than what happened.
 *
 * These two lists are the reason the day file keeps four comms tables instead of
 * two. Everything above them on this page is ground truth — every message and
 * every call attempt, on every platform. Here there are rows only for the
 * traffic that crossed the carrier's own network: SMS, MMS and dialled voice.
 * A WhatsApp message is missing from this section because nothing in an
 * operator's records ever saw it, and a page that quietly filled that gap with a
 * serving cell would be inventing the one thing an investigator would most want.
 *
 * The unit differs too, and it is worth reading the counts twice. A text over
 * 160 characters travels as several 153-character segments and each is its own
 * transaction, so one message can be four rows here — before a group thread
 * multiplies it again by every recipient.
 */
export function CarrierRecords({ view, active, onSeek }: {
  view: CommsView;
  active: string | null;
  onSeek: (minute: number, key: string) => void;
}) {
  const secondOf = new Map(view.messages.map((row) => [row.message.index, row.message.at]));
  const callAt = new Map(view.calls.map((row) => [row.call.index, row.call.at]));

  const sms = view.messages
    .flatMap((row) => row.carrier.map((record) => ({ record, at: row.message.at })))
    .sort((a, b) => a.at - b.at);
  const cdr = view.calls
    .filter((row) => row.record)
    .map((row) => ({ record: row.record!, at: row.call.at, outcome: row.call.outcome }))
    .sort((a, b) => a.at - b.at);
  const handovers = cdr.reduce((total, row) => total + row.record.handovers.length, 0);

  return (
    <>
      <Block
        title="SMS and MMS records"
        meta={`${num(sms.length)} row${sms.length === 1 ? "" : "s"}`}
      >
        {sms.length ? (
          <ol className={LIST}>
            {sms.slice(0, LIMIT).map(({ record, at }, index) => {
              const minute = Math.floor(at / 60);
              const submitted = secondOf.get(record.message) ?? at;
              const key = `sms:${record.message}:${index}`;
              return (
                <li key={`${record.message}-${index}`} className="border-t border-border first:border-0">
                  <button
                    type="button"
                    data-row
                    className={cn(ROW, key === active && CURRENT)}
                    onClick={() => onSeek(minute, key)}
                  >
                    <span className="mt-[0.1rem] tabular-nums text-[0.85rem] font-semibold">
                      {stamp(submitted)}
                    </span>
                    <span className="min-w-0">
                      <strong className="block truncate text-[0.85rem] font-medium tabular-nums">
                        {lineOf(view.subscribers, record.from)} → {lineOf(view.subscribers, record.to)}
                      </strong>
                      <span className={SECOND}>
                        {[
                          record.parts > 1 ? `part ${record.part}/${record.parts}` : "1 part",
                          cellOf(view.cells, record.cell),
                          record.delivered === null
                            ? "no delivery report"
                            : `delivered +${elapsed(Math.max(0, record.delivered - submitted))}`,
                        ].join(" · ")}
                      </span>
                    </span>
                    <span className="mt-[0.15rem] shrink-0 text-[0.78rem] text-muted-foreground tabular-nums">
                      msg {record.message}
                    </span>
                  </button>
                </li>
              );
            })}
            {sms.length > LIMIT ? (
              <li className="border-t border-border px-1.5 py-2 text-[0.85rem] text-muted-foreground">
                {sms.length - LIMIT} more
              </li>
            ) : null}
          </ol>
        ) : (
          <p className="text-[0.85rem] text-muted-foreground">No SMS or MMS records</p>
        )}
      </Block>

      <Block
        title="Call detail records"
        meta={`${num(cdr.length)} dialled · ${num(handovers)} handover${handovers === 1 ? "" : "s"}`}
      >
        {cdr.length ? (
          <ol className={LIST}>
            {cdr.map(({ record, at, outcome }) => {
              const minute = Math.floor((callAt.get(record.call) ?? at) / 60);
              const key = `cdr:${record.call}`;
              return (
                <li key={record.call} className="border-t border-border first:border-0">
                  <button
                    type="button"
                    data-row
                    className={cn(ROW, key === active && CURRENT)}
                    onClick={() => onSeek(minute, key)}
                  >
                    <span className="mt-[0.1rem] tabular-nums text-[0.85rem] font-semibold">
                      {stamp(at)}
                    </span>
                    <span className="min-w-0">
                      <strong className="block truncate text-[0.85rem] font-medium tabular-nums">
                        {lineOf(view.subscribers, record.from)} → {lineOf(view.subscribers, record.to)}
                      </strong>
                      <span className={SECOND}>
                        {[
                          outcome,
                          `from ${cellOf(view.cells, record.originCell)}`,
                          record.endCell === record.originCell
                            ? "same cell"
                            : `ended ${cellOf(view.cells, record.endCell)}`,
                          record.handovers.length
                            ? `${record.handovers.length} handover${record.handovers.length === 1 ? "" : "s"}`
                            : null,
                        ].filter(Boolean).join(" · ")}
                      </span>
                    </span>
                    <span className="mt-[0.15rem] shrink-0 text-[0.78rem] text-muted-foreground tabular-nums">
                      call {record.call}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="text-[0.85rem] text-muted-foreground">No call detail records</p>
        )}
      </Block>
    </>
  );
}
