"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BarList, Columns } from "@/components/Charts";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { PersonLink } from "@/components/PersonLink";
import { useNames } from "@/components/useNames";
import { Block, Grid } from "@/components/console/Section";
import { num, percent, usd, usdCompact, usdExact } from "@/lib/format";
import type { DaySpending } from "@/lib/server/day";
import { useDay } from "@/components/Scope";
import { reasonLabel } from "@/lib/spending";
import { Tile, Tiles } from "@/components/Tiles";

/**
 * The city's money for one generated day.
 *
 * The day page can already show that resident 41,208 paid $8.40 at a deli. What
 * it cannot show is whether $8.40 is a normal deli ticket here, what share of
 * the city's payments were made in currency, or which hour the tills were busy
 * — and those are the figures that say whether `spend.ts` and `bank/routing.ts`
 * are calibrated. Every figure below has a published counterpart, and the
 * notes say which; one that reads wrong against its counterpart is a bug
 * report rather than a curiosity.
 *
 * The aggregate is computed server-side and arrives as a few kilobytes. The
 * rows behind it are tens of megabytes and there is no reason to ship them: no
 * control on this page filters, so nothing here would ever recompute.
 */


/**
 * The CE Diary 2024 weighted median per occasion, which `TICKETS` was fitted
 * against — the same figures `bun run day --sample n --money` prints.
 *
 * Shown beside each category because the median is the one column here that is
 * answerable to a number. The totals are not: they are one weekday multiplied
 * by nothing, and they carry the trip generator's errors as well as the
 * pricing's — a grocery median that is exactly right still totals low when
 * `tours.ts` delivers half the shopping trips its own table asks for.
 */
const CE_MEDIAN: Record<string, number> = {
  grocery: 49.10, "food-sit": 35.00, "food-quick": 12.80, convenience: 9.11,
  cafe: 4.99, retail: 8.23, personal: 27.13, pharmacy: 10.44, fuel: 40.05,
  vehicle: 32.12,
};

export function SpendingWorkspace() {
  const router = useRouter();
  const names = useNames();
  const { day: date, days, error: dayError } = useDay();
  const [spending, setSpending] = useState<DaySpending | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/days/${encodeURIComponent(date)}/spending`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (!cancelled) setSpending(payload as DaySpending);
      })
      .catch((reason) => {
        if (cancelled) return;
        setSpending(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    router.replace(`/spending?date=${encodeURIComponent(date)}`, { scroll: false });
    return () => { cancelled = true; };
  }, [date, router]);

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[86rem] p-6 pb-16">
        <header className="max-w-[56rem]">
          <h1 className="m-0 text-[1.35rem] leading-none font-semibold tracking-tight">Spending</h1>
        </header>

        <form className="mt-6 flex flex-wrap items-end gap-3" onSubmit={(event) => event.preventDefault()}>
          {loading && (days === null || date) ? <StatusText state="busy">Loading…</StatusText> : null}
        </form>

        {days?.length === 0 ? (
          <EmptyState title="No generated days">
            <code className="font-sans text-[max(0.8rem,0.85em)]">cd kierston/sim && bun run day --export-day --date YYYY-MM-DD</code>
          </EmptyState>
        ) : null}
        {error ?? dayError ? <div className="mt-4"><StatusText state="error">{error ?? dayError}</StatusText></div> : null}

        {spending && !spending.banked ? (
          <EmptyState title="No ledger">
            <code className="font-sans text-[max(0.8rem,0.85em)]">cd kierston/sim && bun run day --export-day --date {spending.date}</code>
          </EmptyState>
        ) : null}

        {spending?.banked ? (
          <Grid className="mt-9">
            <Block wide title="Summary">
                <Tiles>
                  <Tile value={num(spending.payments)}>payments</Tile>
                  <Tile value={(spending.payments / Math.max(1, spending.persons)).toFixed(2)}>
                    payments per person-day
                  </Tile>
                  <Tile value={usdCompact(spending.spent)}>spent</Tile>
                  <Tile value={usdExact(spending.medianTicket)}>median ticket</Tile>
                  <Tile value={percent(spending.cashShare)}>cash share</Tile>
                  <Tile value={num(spending.payers)}>payers</Tile>
                  <Tile value={num(spending.withdrawals)}>cash withdrawals</Tile>
                  <Tile value={usdCompact(spending.withdrawn)}>withdrawn</Tile>
                </Tiles>
              </Block>

            <Block wide title="Hourly totals">
                <Columns
                  bars={spending.hours.map((hour) => ({
                    label: String(hour.hour),
                    value: hour.total,
                    title: `${String(hour.hour).padStart(2, "0")}:00 · ${usd(hour.total)} · ${num(hour.count)} payments`,
                  }))}
                  label={(index) => `${String(index).padStart(2, "0")}:00`}
                />
              </Block>

            <Block wide title="Categories">
                <div className="grid gap-0">
                  <div className="grid grid-cols-[minmax(9rem,1.4fr)_5rem_5.5rem_5.5rem_4rem] gap-2 border-b border-border pb-1 text-[0.78rem] font-medium text-muted-foreground max-[51.25rem]:grid-cols-[1fr_4rem_4.5rem]">
                    <span>Category</span>
                    <span className="text-right">Charges</span>
                    <span className="text-right">Median</span>
                    <span className="text-right max-[51.25rem]:hidden">CE Diary</span>
                    <span className="text-right max-[51.25rem]:hidden">Share</span>
                  </div>
                  {spending.categories.map((category) => (
                    <div
                      key={category.reason}
                      className="grid grid-cols-[minmax(9rem,1.4fr)_5rem_5.5rem_5.5rem_4rem] items-baseline gap-2 border-b border-border py-1 last:border-0 max-[51.25rem]:grid-cols-[1fr_4rem_4.5rem]"
                    >
                      <span className="min-w-0">
                        <strong className="block truncate text-[0.78rem]">
                          {reasonLabel(category.reason)}
                        </strong>
                        <span className="block truncate text-[0.78rem] text-muted-foreground">
                          {usd(category.total)}
                        </span>
                      </span>
                      <span className="tabular-nums text-right text-[0.85rem]">{num(category.count)}</span>
                      <span className="tabular-nums text-right text-[0.85rem] font-semibold">
                        {usdExact(category.median)}
                      </span>
                      <span className="tabular-nums text-right text-[0.85rem] text-muted-foreground max-[51.25rem]:hidden">
                        {CE_MEDIAN[category.reason] ? usdExact(CE_MEDIAN[category.reason]) : "—"}
                      </span>
                      <span className="tabular-nums text-right text-[0.85rem] text-muted-foreground max-[51.25rem]:hidden">
                        {percent(category.share)}
                      </span>
                    </div>
                  ))}
                </div>
              </Block>

            <Block title="Payment methods">
                <BarList bands={spending.instruments} />
              </Block>

            <Block title="Ticket sizes">
                <BarList bands={spending.tickets} />
              </Block>

            <Block title="Recipients">
                <div className="grid gap-0">
                  {spending.merchants.map((merchant) => (
                    <div
                      key={merchant.merchant}
                      className="grid grid-cols-[1fr_3.5rem_5rem] items-baseline gap-2 border-b border-border py-1 last:border-0"
                    >
                      <span className="truncate text-[0.85rem]">{merchant.merchant}</span>
                      <span className="tabular-nums text-right text-[0.82rem] text-muted-foreground">
                        {num(merchant.count)}
                      </span>
                      <span className="tabular-nums text-right text-[0.85rem]">{usd(merchant.total)}</span>
                    </div>
                  ))}
                </div>
              </Block>

            <Block title="Merchant categories">
                <div className="grid gap-0">
                  {spending.mccs.map((row) => (
                    <div
                      key={row.mcc}
                      className="grid grid-cols-[3rem_1fr_5rem] items-baseline gap-2 border-b border-border py-1 last:border-0"
                    >
                      <span className="tabular-nums text-[0.85rem] font-semibold">{row.mcc}</span>
                      <span className="truncate text-[0.82rem] text-muted-foreground">
                        {row.label ?? "unnamed code"}
                      </span>
                      <span className="tabular-nums text-right text-[0.85rem]">{usd(row.total)}</span>
                    </div>
                  ))}
                </div>
              </Block>

            <Block title="Top spenders">
                <div className="grid gap-0">
                  {spending.spenders.map((spender) => (
                    <div
                      key={spender.person}
                      className="grid grid-cols-[1fr_3.5rem_5rem] items-baseline gap-2 border-b border-border py-1 last:border-0"
                    >
                      <span className="min-w-0 truncate text-[0.85rem]">
                        <PersonLink names={names} person={spender.person} />
                      </span>
                      <span className="tabular-nums text-right text-[0.82rem] text-muted-foreground">
                        {spender.count}
                      </span>
                      <span className="tabular-nums text-right text-[0.85rem]">{usd(spender.total)}</span>
                    </div>
                  ))}
                </div>
              </Block>

            <Block
              title="Declines"
              meta={spending.declined
                ? `${num(spending.declined)} of ${num(spending.transactions)} · ${percent(spending.declined / Math.max(1, spending.transactions))}`
                : undefined}
            >
                {spending.declined ? (
                  <BarList bands={spending.declines} />
                ) : (
                  <p className="text-[0.85rem] text-muted-foreground">No declines</p>
                )}
            </Block>
          </Grid>
        ) : null}

        {spending?.banked ? (
          <p className="mt-4 text-[0.82rem] text-muted-foreground">
            sim/src/economy/spend.ts · {spending.date} · {num(spending.transactions)} rows
            · {num(spending.persons)} residents
          </p>
        ) : null}
      </div>
    </main>
  );
}
