"use client";

import { useMemo } from "react";
import Link from "next/link";
import { BarList, Pyramid } from "@/components/Charts";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { Block, Grid, Section } from "@/components/console/Section";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useEmployment } from "@/components/useEmployment";
import { useEnrollment } from "@/components/useEnrollment";
import { usePopulation } from "@/components/usePopulation";
import { num, percent, usd } from "@/lib/format";
import { summariseSchools } from "@/lib/school-summary";
import { summarise } from "@/lib/summary";
import { summariseWork } from "@/lib/work-summary";
import { Tile, Tiles } from "@/components/Tiles";

/**
 * The landing page: every distribution the app can compute over the whole
 * city, in one place.
 */

const smallText = "text-[max(0.8rem,0.85em)]";

export default function AggregatesPage() {
  const { population, error, elapsed } = usePopulation();
  // The employment table is another 10 MB, so the population sections render
  // as soon as they can and the work ones fill in behind them.
  const work = useEmployment();
  // And the enrollment table is another 4 MB behind that one.
  const study = useEnrollment();
  const summary = useMemo(() => (population ? summarise(population) : null), [population]);
  const jobs = useMemo(
    () => (work.employment && work.labels && work.population
      ? summariseWork(work.employment, work.labels, work.population)
      : null),
    [work.employment, work.labels, work.population],
  );
  const schools = useMemo(
    () => (study.enrollment && study.population
      ? summariseSchools(study.enrollment, study.population)
      : null),
    [study.enrollment, study.population],
  );

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[86rem] p-6 pb-16">
        <header className="mb-10 max-w-[56rem]">
          <p className="micro m-0">Kierston</p>
          <h1 className="mt-2 mb-0 text-[1.35rem] leading-none font-semibold tracking-tight">
            Global aggregates
          </h1>
          <p className="mt-3 mb-0 text-[0.9rem] text-muted-foreground">
            <Link href="/map?panel=analysis">Area analysis</Link>
          </p>
        </header>

        {error ? (
          <Section title="No population">
            <StatusText state="error">{error}</StatusText>
            <div className="mt-2">
              <code className={smallText}>python kierston/init/population/pack_population.py</code>
            </div>
          </Section>
        ) : !summary ? (
          <EmptyState>Loading…</EmptyState>
        ) : (
          <>
            <Section
              title="Population"
              meta={elapsed ? `${Math.round(elapsed)} ms` : undefined}
            >
              <Tiles>
                <Tile value={num(summary.people)}>residents</Tile>
                <Tile value={num(summary.households)}>households</Tile>
                <Tile value={summary.averageHouseholdSize.toFixed(2)}>people per household</Tile>
                <Tile value={usd(summary.medianHouseholdIncome)}>median household income</Tile>
                <Tile value={summary.medianAge.toFixed(0)}>median age</Tile>
                <Tile value={num(summary.quarters)}>group quarters</Tile>
                <Tile value={num(summary.dwellingBuildings)}>residential buildings</Tile>
              </Tiles>

              <Grid className="mt-9">
                <Block title="Age and sex">
                  <Pyramid rows={summary.pyramid} />
                </Block>

                <Block title="Household size">
                  <BarList bands={summary.sizes} />
                </Block>

                <Block title="Household income">
                  <BarList bands={summary.incomes} />
                </Block>

                <Block title="Race and ethnicity">
                  <BarList bands={summary.races} />
                </Block>

                <Block title="Employment, 16 and over">
                  <BarList bands={summary.employment} />
                </Block>
              </Grid>
            </Section>

            {work.error ? (
              <Section title="Work">
                <StatusText state="error">{work.error}</StatusText>
                <div className="mt-2 flex flex-col gap-1">
                  <code className={smallText}>python kierston/init/work/init_work.py</code>
                  <code className={smallText}>python kierston/init/work/assign_work.py</code>
                </div>
              </Section>
            ) : !jobs ? (
              <Section title="Work">
                <StatusText state="busy">Loading…</StatusText>
              </Section>
            ) : (
              <Section title="Work">
                <Tiles>
                  <Tile value={num(jobs.workers)}>employed</Tile>
                  <Tile value={percent(jobs.workers / jobs.employed, 0)}>of PUMS employed</Tile>
                  <Tile value={num(jobs.sitesUsed)}>staffed workplaces</Tile>
                  <Tile value={percent(jobs.workers / jobs.seats, 0)}>of {num(jobs.seats)} seats</Tile>
                  <Tile value={`${jobs.medianCommute.toFixed(0)} min`}>median commute</Tile>
                  <Tile value={jobs.medianHours.toFixed(0)}>median hours a week</Tile>
                </Tiles>

                <Grid className="mt-9">
                  <Block title="Work location">
                    <BarList bands={jobs.modes} />
                  </Block>

                  <Block title="Commute">
                    <BarList bands={jobs.commutes} />
                  </Block>

                  <Block title="Departure">
                    <BarList bands={jobs.departures} />
                  </Block>

                  <Block title="Largest industry sectors">
                    <BarList bands={jobs.sectors} total={jobs.workers} />
                  </Block>

                  <Block title="Occupation groups">
                    <BarList bands={jobs.occupationGroups} total={jobs.workers} />
                  </Block>
                </Grid>
              </Section>
            )}

            {study.error ? (
              <Section title="School">
                <StatusText state="error">{study.error}</StatusText>
                <div className="mt-2 flex flex-col gap-1">
                  <code className={smallText}>python kierston/init/education/schools.py</code>
                  <code className={smallText}>python kierston/init/education/assign_school.py</code>
                </div>
              </Section>
            ) : !schools ? (
              <Section title="School">
                <StatusText state="busy">Loading…</StatusText>
              </Section>
            ) : (
              <Section title="School">
                <Tiles>
                  <Tile value={num(schools.students)}>enrolled</Tile>
                  <Tile value={num(schools.placed)}>enrolled in Kierston</Tile>
                  <Tile value={percent(schools.external / schools.students, 0)}>enrolled outside Kierston</Tile>
                  <Tile value={num(schools.schoolsUsed)}>schools with students</Tile>
                  <Tile value={percent(schools.placed / schools.seats, 0)}>of {num(schools.seats)} places</Tile>
                  <Tile value={`${schools.medianTrip.toFixed(0)} min`}>median trip to school</Tile>
                </Tiles>

                <Grid className="mt-9">
                  <Block title="Enrollment by age">
                    <BarList bands={schools.bands} />
                  </Block>

                  <Block title="Trip to school">
                    <BarList bands={schools.trips} />
                  </Block>

                  <Block title="Departure">
                    <BarList bands={schools.starts} />
                  </Block>

                  <Block title="School sector">
                    <BarList bands={schools.sectors} total={schools.placed} />
                  </Block>

                  <Block title="Capacity">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Band</TableHead>
                          <TableHead className="text-right tabular-nums">Places</TableHead>
                          <TableHead className="text-right tabular-nums">PUMS demand</TableHead>
                          <TableHead className="text-right tabular-nums">Fit</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {schools.fit.map((row) => (
                          <TableRow key={row.label}>
                            <TableCell>{row.label}</TableCell>
                            <TableCell className="text-right tabular-nums">{num(row.seats)}</TableCell>
                            <TableCell className="text-right tabular-nums">{num(row.wanted)}</TableCell>
                            <TableCell className="text-right tabular-nums">
                              {row.wanted ? percent(row.seats / row.wanted, 0) : "—"}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Block>
                </Grid>
              </Section>
            )}
          </>
        )}
      </div>
    </main>
  );
}
