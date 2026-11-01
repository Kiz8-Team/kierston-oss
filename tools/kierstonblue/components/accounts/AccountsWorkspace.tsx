"use client";

import { useEffect, useState } from "react";
import { Columns } from "@/components/Charts";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { Block, Grid, Section } from "@/components/console/Section";
import { Tile, Tiles } from "@/components/Tiles";
import { channelColor, channelLabel } from "@/lib/comms";
import { num, percent } from "@/lib/format";
import type { AccountsSummary } from "@/lib/server/accounts";

/**
 * Whether the city holds the platforms in the shares they were fitted to.
 *
 * Only the city. One person's handles are a personal record like any other and
 * are read off their dossier, packed into identity.bin beside the handset and
 * the line — a page that stepped through residents one at a time could show
 * that resident 41,208 is on Snapchat, but not whether Snapchat is right.
 * Adoption against the published targets is the figure that can be wrong, so
 * it is the one this page carries.
 */

export function AccountsWorkspace() {
  const [city, setCity] = useState<AccountsSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/accounts/summary")
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        setCity(payload as AccountsSummary);
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, []);

  const apps = city?.adoption.filter((row) => row.target !== null) ?? [];
  const worst = apps.reduce(
    (far, row) => Math.max(far, Math.abs(row.share - (row.target ?? row.share))),
    0,
  );

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[86rem] p-6 pb-16">
        <header>
          <h1 className="m-0 text-[1.35rem] leading-none font-semibold tracking-tight">
            Messaging accounts
          </h1>
        </header>

        {error ? (
          <div className="mt-6">
            <EmptyState title="No accounts file">
              <StatusText state="error">{error}</StatusText>
              <p className="mt-2">
                <code>python kierston/init/personal_records/accounts.py</code>
              </p>
            </EmptyState>
          </div>
        ) : null}

        {city ? (
          <div className="mt-9">
            <Section title="Summary" meta={`as of ${city.asOf} · seed ${city.seed}`}>
              <Tiles>
                <Tile value={num(city.people)}>people with a line</Tile>
                <Tile value={num(city.accounts)}>accounts</Tile>
                <Tile value={(city.accounts / city.people).toFixed(1)}>accounts per person</Tile>
                <Tile value={num(city.conversations)}>group conversations</Tile>
                <Tile value={percent(worst, 1)}>max deviation from target</Tile>
              </Tiles>
            </Section>

            <Section title="Reach" meta="share of people with a line">
              <Grid min="27rem">
                <Block title="Platform" meta="share vs target">
                  <div className="grid gap-2">
                    {city.adoption.map((row) => (
                      <Reach key={row.channel} {...row} />
                    ))}
                  </div>
                </Block>

                <Block title="Accounts per person" meta={`${num(city.people)} people`}>
                  <Columns
                    bars={city.held.map((count, index) => ({
                      label: String(index + 1),
                      value: count,
                      title: `${index + 1} · ${num(count)} people · ${percent(count / city.people)}`,
                    }))}
                    every={1}
                    label={(index) => String(index + 1)}
                  />
                </Block>

                <Block
                  title="Opened"
                  meta={`${city.opened.at(0)?.year ?? ""}–${city.opened.at(-1)?.year ?? ""}`}
                  wide
                >
                  <Columns
                    bars={city.opened.map((row) => ({
                      label: String(row.year),
                      value: row.count,
                      title: `${row.year} · ${num(row.count)} accounts`,
                    }))}
                    every={2}
                    label={(index) => String(city.opened[index]?.year ?? "")}
                  />
                </Block>
              </Grid>
            </Section>

            <Section title="Intercepts">
              <div className="grid max-w-[46rem] gap-0">
                {apps.map((row) => (
                  <div
                    key={row.channel}
                    className="grid grid-cols-[10rem_repeat(3,minmax(0,1fr))] items-baseline gap-4 border-t border-border py-2 text-[0.9rem] first:border-t-0"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden
                        className="inline-block size-[0.5rem] shrink-0 rounded-[2px]"
                        style={{ background: channelColor(row.channel) }}
                      />
                      {channelLabel(row.channel)}
                    </span>
                    <span className="text-right tabular-nums">{percent(row.share)}</span>
                    <span className="text-right text-muted-foreground tabular-nums">
                      target {percent(row.target ?? 0)}
                    </span>
                    <span className="text-right text-muted-foreground tabular-nums">
                      {row.intercept?.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        ) : error ? null : (
          <div className="mt-6"><StatusText state="busy">Loading…</StatusText></div>
        )}
      </div>
    </main>
  );
}

/**
 * One platform's reach, with the number it was fitted to marked on the groove.
 *
 * The mark is inside the bar rather than in a column beside it because the
 * comparison is the whole point of the row: a fill that stops short of its own
 * mark is a miscalibration you can see without reading either figure.
 */
function Reach({ channel, holders, share, target }: {
  channel: string;
  holders: number;
  share: number;
  target: number | null;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_4rem_5.5rem] items-center gap-3">
      <span className="flex items-center gap-2 text-[0.85rem]">
        <span
          aria-hidden
          className="inline-block size-[0.5rem] shrink-0 rounded-[2px]"
          style={{ background: channelColor(channel) }}
        />
        {channelLabel(channel)}
      </span>
      <span className="relative block h-[0.7rem] overflow-hidden rounded-[4px] bg-[var(--grid-line)]">
        <i
          className="block h-full rounded-[4px]"
          style={{ width: `${share * 100}%`, background: channelColor(channel) }}
        />
        {target !== null ? (
          <i
            aria-hidden
            className="absolute top-[-2px] bottom-[-2px] w-[2px] bg-foreground"
            style={{ left: `calc(${target * 100}% - 1px)` }}
          />
        ) : null}
      </span>
      <span className="text-right text-[0.85rem] tabular-nums">{percent(share)}</span>
      <span className="text-right text-[0.85rem] text-muted-foreground tabular-nums">
        {target === null ? num(holders) : `target ${percent(target)}`}
      </span>
    </div>
  );
}
