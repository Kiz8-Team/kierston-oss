"use client";

import { BarList } from "@/components/Charts";
import { Block, Grid, Section } from "@/components/console/Section";
import type { BankingSummary } from "@/lib/banking-summary";
import { num, percent, usd, usdCompact, usdExact } from "@/lib/format";
import { Tile, Tiles } from "@/components/Tiles";

/**
 * The city's money, before any of it is a row.
 *
 * Every figure on this page has a published counterpart — the FDIC's unbanked
 * share, the SCF's account balances, the Fed's payment diary — because that is
 * the only thing that makes an aggregate over synthetic data worth showing. A
 * reader who knows one of those numbers can look at the matching tile and tell
 * whether banking.py is calibrated, which is not a question the row tables can
 * answer at any length of scrolling.
 *
 * The notes under each figure say what the number is against. They are the
 * point of the figure, not a caption.
 */

export function BankingOverview({ summary }: { summary: BankingSummary }) {
  const adults = summary.banked + summary.unbanked;
  const utilisation = summary.creditLimit > 0
    ? summary.creditDrawn / summary.creditLimit
    : 0;

  return (
    <div className="mx-auto w-full max-w-[82rem] px-1 pb-10">
      <Section title="Deposits">
        <Tiles>
          <Tile value={num(summary.covered)}>people with a position</Tile>
          <Tile value={num(summary.banked)}>banked</Tile>
          <Tile value={percent(adults ? summary.unbanked / adults : 0)}>
            unbanked, 15 and over
          </Tile>
          <Tile value={num(summary.neobankOnly)}>neobank only</Tile>
          <Tile value={num(summary.accounts)}>deposit accounts</Tile>
          <Tile value={usdCompact(summary.deposits)}>on deposit</Tile>
          <Tile value={usdExact(summary.medianEveryday)}>median everyday balance</Tile>
          <Tile value={usdCompact(summary.currency)}>currency carried</Tile>
        </Tiles>

        <Grid className="mt-7">
          <Block title="Deposit balances" meta={`${num(summary.overdrawn)} overdrawn`}>
            <BarList bands={summary.balances} />
          </Block>

          <Block title="Currency carried" meta={`median ${usdExact(summary.medianCash)}`}>
            <BarList bands={summary.cashHeld} />
          </Block>

          <Block title="Account purpose">
            <BarList bands={summary.purposes} />
          </Block>

          <Block title="Institutions">
            <BarList bands={summary.institutions} />
          </Block>
        </Grid>
      </Section>

      <Section title="Income">
        <Tiles>
          <Tile value={num(summary.streams)}>income streams</Tile>
          <Tile value={num(summary.withoutIncome)}>people without income</Tile>
          <Tile value={usdExact(summary.medianNet)}>median net per payment</Tile>
          <Tile value={usdCompact(summary.netAnnual)}>net pay per year</Tile>
          <Tile value={percent(summary.streams ? summary.paidInCash / summary.streams : 0)}>
            streams paid in currency
          </Tile>
        </Tiles>

        <Grid className="mt-7">
          <Block title="Source">
            <BarList bands={summary.sources} />
          </Block>

          <Block title="Frequency">
            <BarList bands={summary.frequencies} />
          </Block>

          <Block title="Payday">
            <BarList bands={summary.paydays} />
          </Block>

          <Block title="Method">
            <BarList bands={summary.methods} />
          </Block>
        </Grid>
      </Section>

      <Section title="Cards and credit" meta={`${usd(summary.creditDrawn)} outstanding`}>
        <Tiles>
          <Tile value={num(summary.creditCards)}>credit cards</Tile>
          <Tile value={num(summary.cardholders)}>cardholders</Tile>
          <Tile value={num(summary.debitCards)}>debit cards</Tile>
          <Tile value={usdCompact(summary.creditLimit)}>credit extended</Tile>
          <Tile value={percent(utilisation)}>utilisation</Tile>
        </Tiles>

        <Grid className="mt-7">
          <Block title="Cash preference">
            <BarList bands={summary.cashPreference} />
          </Block>
        </Grid>
      </Section>

    </div>
  );
}
