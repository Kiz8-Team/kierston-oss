"use client";

import { channelColor, channelLabel } from "@/lib/comms";
import type { CommsThread } from "@/lib/server/comms";
import { cn } from "@/lib/utils";

const ROW = "grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-x-2.5 gap-y-0.5 "
  + "rounded-sm px-1.5 py-1.5 text-left leading-tight hover:bg-accent";

const CURRENT = "bg-accent ring-1 ring-primary/30";

const LIST = "grid max-h-[26rem] list-none gap-0 overflow-auto p-0";

/**
 * Every thread this person is in, busiest first.
 *
 * Standing groups and today's pairs are one list because the file makes them one
 * table, and the difference between them is real but is not a reason to look in
 * two places: a household group that said nothing today and a colleague who sent
 * one message are both answers to "who is this person in contact with".
 *
 * A silent thread is still shown. A family group with no traffic on a Tuesday is
 * a fact about the Tuesday, and a page that hid it would make everybody look
 * like they only belong to the threads they happened to use.
 */
export function ThreadList({ threads, selected, onSelect, name }: {
  threads: CommsThread[];
  /** The thread whose traffic the lists below are showing, or null for all. */
  selected: number | null;
  onSelect: (thread: number | null) => void;
  name: (thread: CommsThread) => string;
}) {
  const ordered = [...threads].sort((a, b) =>
    (b.messages + b.calls) - (a.messages + a.calls) || a.index - b.index);

  return (
    <ol className={LIST}>
      {ordered.map((thread) => {
        const traffic = thread.messages + thread.calls;
        return (
          <li key={thread.index} className="border-t border-border first:border-0">
            <button
              type="button"
              className={cn(ROW, selected === thread.index && CURRENT)}
              onClick={() => onSelect(selected === thread.index ? null : thread.index)}
            >
              <span className="min-w-0">
                <span className="flex items-start gap-1.5">
                  <span
                    aria-hidden
                    className="mt-[0.3rem] inline-block size-[0.5rem] shrink-0 rounded-[2px]"
                    style={{ background: channelColor(thread.channel) }}
                  />
                  <strong className="min-w-0 truncate text-[0.88rem]">{name(thread)}</strong>
                </span>
                <span className="mt-0.5 block text-[0.8rem] leading-[1.45] text-pretty text-muted-foreground">
                  {[
                    channelLabel(thread.channel),
                    thread.kind === "dyad" ? null : thread.kind,
                    thread.participants.length === 2
                      ? "one to one"
                      : `${thread.participants.length} people`,
                    // Why these particular people are in a thread together,
                    // which is the honest answer and also what a consumer of
                    // this data is trying to infer.
                    thread.focus,
                  ].filter(Boolean).join(" · ")}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="block text-[0.85rem] font-semibold tabular-nums">
                  {traffic || "—"}
                </span>
                <span className="mt-px block text-[0.78rem] text-muted-foreground tabular-nums">
                  {thread.calls
                    ? `${thread.messages} msg · ${thread.calls} call${thread.calls === 1 ? "" : "s"}`
                    : traffic ? "messages" : "silent"}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
