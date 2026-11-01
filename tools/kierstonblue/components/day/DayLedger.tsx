"use client";

import { Fact, Facts } from "@/components/browse/detail";
import { DayList, DayRow } from "@/components/day/DayRow";
import { DAY_END, DAY_START, clock } from "@/lib/day-timeline";
import { usdExact } from "@/lib/format";
import type { DayTransaction } from "@/lib/server/day";
import { instrumentLabel, reasonLabel, transactionColor } from "@/lib/spending";

/**
 * What the day cost this person, at the minute each part of it was paid.
 *
 * Read against the schedule rather than instead of it, because the claim
 * `spend.ts` makes is that the two line up: the money leaves at the till and
 * not at the door. Clicking a row parks the day cursor on it, so the map and
 * the timeline move to the moment the card was presented.
 *
 * A declined row is kept. Somebody whose everyday account is overdrawn and who
 * has no card gets one, and that is as much a fact about their day as the
 * groceries they did not leave with.
 */
export function DayLedger({ transactions, cursor, onSeek }: {
  transactions: DayTransaction[];
  cursor: number;
  onSeek: (minute: number) => void;
}) {
  if (!transactions.length) return <p className="m-0 py-2 text-[0.78rem] text-muted-foreground">No payments</p>;
  return (
    <DayList>
      {transactions.map((transaction, index) => {
        const at = Math.min(DAY_END, Math.max(DAY_START, transaction.minute));
        return (
          <DayRow
            key={`${transaction.minute}-${index}`}
            time={clock(at)}
            title={transaction.merchant ?? "Unnamed merchant"}
            figure={usdExact(transaction.amount)}
            swatch={transactionColor(transaction)}
            muted={!transaction.approved}
            active={Math.abs(cursor - at) < 8}
            onSeek={() => onSeek(at)}
          >
            <Facts cols={3}>
              <Fact label="Reason">{reasonLabel(transaction.reason)}</Fact>
              <Fact label="Paid by">{instrumentLabel(transaction)}</Fact>
              <Fact label="Status">
                {transaction.approved ? "Approved" : `Declined${transaction.decline ? ` · ${transaction.decline}` : ""}`}
              </Fact>
              {transaction.mcc ? <Fact label="MCC">{transaction.mcc}</Fact> : null}
              {transaction.balanceAfter !== null ? (
                <Fact label="Balance after">{usdExact(transaction.balanceAfter)}</Fact>
              ) : null}
            </Facts>
          </DayRow>
        );
      })}
    </DayList>
  );
}
