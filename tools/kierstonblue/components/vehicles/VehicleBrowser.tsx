"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Clock, MapPin, Route, Users } from "lucide-react";
import { EmptyState, StatusText } from "@/components/browse/EmptyState";
import { DayTimeline } from "@/components/day/DayTimeline";
import { useDay } from "@/components/Scope";
import { PERSON_LINK, PID, PersonLink, personName } from "@/components/PersonLink";
import { VehicleMap } from "@/components/vehicles/VehicleMap";
import { useNames } from "@/components/useNames";
import { Badge } from "@/components/ui/badge";
import { Block } from "@/components/console/Section";
import { Button } from "@/components/ui/button";
import { DAY_END, DAY_START, clock, duration } from "@/lib/day-timeline";
import type { VehicleDay, VehiclePassenger } from "@/lib/server/vehicles";
import {
  MATCH_NOTE, SERVICE_LABEL, buildVehicleTimeline, clockOfSecond, occupancyAt,
  vehiclePositionAt,
} from "@/lib/vehicle-day";
import { cn } from "@/lib/utils";

/**
 * One vehicle's day.
 *
 * /days plays a resident's day and says how they travelled. This plays the
 * car's day and says who was in it, which for a shared car or a cab is a
 * different story: the same VIN carries three people to three places before
 * lunch, and none of their pages say so.
 *
 * The page is opened from a VIN — in the register, in a dossier, on a camera
 * read, on a leg of somebody's day — so it opens on that vehicle rather than
 * on a way to choose one. The date is the header's.
 */
export function VehicleBrowser({ vin }: { vin: string }) {
  const router = useRouter();
  const names = useNames();

  const { day: date, error: dayError } = useDay();
  const [day, setDay] = useState<VehicleDay | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [cursor, setCursor] = useState(DAY_START);
  const [playing, setPlaying] = useState(false);
  const [fitToken, setFitToken] = useState(0);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setCursor(DAY_START);
    setPlaying(false);
    setFitToken((token) => token + 1);
    fetch(`/api/vehicles/${encodeURIComponent(vin)}/${encodeURIComponent(date)}`)
      .then(async (response) => {
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
        if (!cancelled) setDay(payload as VehicleDay);
      })
      .catch((reason) => {
        if (cancelled) return;
        setDay(null);
        setError(reason instanceof Error ? reason.message : String(reason));
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    router.replace(`/vehicles/${encodeURIComponent(vin)}?date=${encodeURIComponent(date)}`, { scroll: false });
    return () => { cancelled = true; };
  }, [vin, date, router]);

  const segments = useMemo(() => (day ? buildVehicleTimeline(day) : []), [day]);
  const activeIndex = useMemo(() => {
    const found = segments.findIndex(
      (segment) => cursor >= segment.start && cursor < segment.end && segment.travel,
    );
    return found < 0 ? null : segments[found]!.legIndex;
  }, [segments, cursor]);
  const position = useMemo(() => (day ? vehiclePositionAt(day, cursor) : null), [day, cursor]);
  const aboard = useMemo(() => (day ? occupancyAt(day, cursor) : null), [day, cursor]);

  const seek = useCallback((minute: number) => {
    setPlaying(false);
    setCursor(Math.min(DAY_END, Math.max(DAY_START, minute)));
  }, []);

  const selectMovement = useCallback((movement: number) => {
    const found = day?.movements[movement];
    seek(found ? found.start / 60 : DAY_START);
    setFitToken((token) => token + 1);
  }, [day, seek]);

  return (
    <main id="content" className="relative h-full overflow-auto">
      <div className="mx-auto max-w-[92rem] p-6 pb-16">
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div>
            <h1 className="m-0 text-[1.35rem] leading-none font-semibold tracking-tight">
              {vin}
            </h1>
            <p className="mt-2 mb-0 text-[0.85rem] text-muted-foreground">
              {day ? <Summary day={day} names={names} /> : "Loading…"}
            </p>
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <Button asChild variant="outline">
              <Link href={`/vehicles?q=${encodeURIComponent(vin)}`}>Registration</Link>
            </Button>
            {day?.drivers.length ? (
              <Button asChild variant="outline">
                <Link href={`/days?date=${encodeURIComponent(date)}&person=${day.drivers[0]}`}>
                  Driver&rsquo;s day
                </Link>
              </Button>
            ) : null}
          </div>
        </header>

        {error ?? dayError ? <div className="mt-6"><StatusText state="error">{error ?? dayError}</StatusText></div> : null}
        {loading && !day && !error && !dayError ? (
          <EmptyState>Loading…</EmptyState>
        ) : null}

        {day ? (
          <>
            <Block
              className="mt-9"
              title={<span className="flex items-center gap-2"><Clock className="size-4" />Timeline</span>}
            >
              <DayTimeline
                segments={segments}
                minute={cursor}
                playing={playing}
                onPlayingChange={setPlaying}
                onScrub={setCursor}
              />
            </Block>

            <Block
              className="mt-9"
              title={<span className="flex items-center gap-2"><Users className="size-4" />Aboard at {clock(cursor)}</span>}
            >
              <Aboard names={names} aboard={aboard} date={date} />
            </Block>

            <Block
              className="mt-9"
              title={<span className="flex items-center gap-2"><MapPin className="size-4" />Map</span>}
            >
              <VehicleMap
                day={day}
                active={activeIndex}
                position={position}
                fitToken={fitToken}
                onSelect={selectMovement}
              />
            </Block>

            <Block
              className="mt-9"
              title={<span className="flex items-center gap-2"><Route className="size-4" />Movements</span>}
            >
              <Movements
                day={day}
                names={names}
                active={activeIndex}
                onSelect={selectMovement}
              />
            </Block>
          </>
        ) : null}
      </div>
    </main>
  );
}

/** The one line under the VIN: what this vehicle is, and what it did today. */
function Summary({ day, names }: { day: VehicleDay; names: ReturnType<typeof useNames> }) {
  return (
    <>
      {SERVICE_LABEL[day.serviceClass] ?? day.serviceClass} ·{" "}
      {day.ownerType === "person"
        ? <>owner <PersonLink names={names} person={day.owner} /></>
        : <>operator <span className={PID}>{day.owner}</span></>}
      {day.household === null ? null : <> · household <span className={PID}>{day.household}</span></>}
      {" · "}
      {day.movements.length
        ? <>
          {day.movements.length} movement{day.movements.length === 1 ? "" : "s"} ·{" "}
          {day.kilometres.toFixed(1)} km · {duration(day.movingSeconds / 60)} in motion ·{" "}
          {day.drivers.length === 1
            ? <>driver {personName(names, day.drivers[0]!)}</>
            : `${day.drivers.length} drivers`}
        </>
        : "stationary"}
    </>
  );
}

/**
 * Who is in the vehicle at the cursor.
 *
 * A parked car is empty — the file has no seat occupancy, and putting somebody
 * in a stationary car would be a claim it does not make.
 */
function Aboard({ names, aboard, date }: {
  names: ReturnType<typeof useNames>;
  aboard: ReturnType<typeof occupancyAt> | null;
  date: string;
}) {
  if (!aboard?.movement) {
    return (
      <p className="text-[0.85rem] text-muted-foreground">Parked</p>
    );
  }
  const movement = aboard.movement;
  return (
    <div className="grid gap-3">
      <p className="m-0 text-[0.85rem]">
        <span className="font-semibold">{movement.mode}</span> · {movement.purpose} ·{" "}
        {movement.from.label ?? "Unnamed place"} → {movement.to.label ?? "Unnamed place"} ·{" "}
        {movement.kilometres.toFixed(1)} km
      </p>
      <ol className="grid list-none gap-0 p-0">
        <li className="border-t border-border">
          <span className="grid grid-cols-[5rem_1fr] items-baseline gap-2 px-1.5 py-1 text-[0.85rem]">
            <span className="text-muted-foreground">Driver</span>
            <span>
              {aboard.driver === null ? (
                <span className="text-muted-foreground">not recorded</span>
              ) : (
                <>
                  <PersonLink names={names} person={aboard.driver} />{" "}
                  <Link
                    className={PERSON_LINK}
                    href={`/days?date=${encodeURIComponent(date)}&person=${aboard.driver}`}
                  >
                    Day
                  </Link>
                </>
              )}
            </span>
          </span>
        </li>
        {movement.passengers.length ? movement.passengers.map((passenger) => (
          <li key={`${passenger.person}-${passenger.depart}`} className="border-t border-border">
            <span className="grid grid-cols-[5rem_1fr] items-baseline gap-2 px-1.5 py-1 text-[0.85rem]">
              <span className="text-muted-foreground">Passenger</span>
              <span>
                <PersonLink names={names} person={passenger.person} />
                <span className="ml-1.5 text-[0.78rem] text-muted-foreground">
                  {passenger.purpose} · {clock(passenger.depart)}–{clock(passenger.arrive)} ·{" "}
                  {evidence(passenger)}
                </span>
              </span>
            </span>
          </li>
        )) : (
          <li className="border-t border-border">
            <span className="block px-1.5 py-1 text-[0.85rem] text-muted-foreground">
              No passengers
            </span>
          </li>
        )}
      </ol>
    </div>
  );
}

function evidence(passenger: VehiclePassenger): string {
  const note = MATCH_NOTE[passenger.match];
  return passenger.match === "journey" || passenger.alone
    ? note
    : `${note} · ambiguous`;
}

function Movements({ day, names, active, onSelect }: {
  day: VehicleDay;
  names: ReturnType<typeof useNames>;
  active: number | null;
  onSelect: (index: number) => void;
}) {
  if (!day.movements.length) {
    return (
      <p className="text-[0.85rem] text-muted-foreground">No movements</p>
    );
  }
  return (
    <ol className="grid list-none gap-0 p-0">
      {day.movements.map((movement, index) => (
        <li key={movement.leg} className="border-t border-border first:border-0">
          <button
            type="button"
            className={cn(
              "grid w-full grid-cols-[3.5rem_1fr_auto] items-baseline gap-2 rounded-sm px-1.5 py-1 text-left leading-tight hover:bg-accent",
              active === index && "bg-accent ring-1 ring-primary/30",
            )}
            onClick={() => onSelect(index)}
          >
            <span className="tabular-nums text-[0.85rem] font-semibold">
              {clockOfSecond(movement.start)}
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1 text-[0.88rem] font-semibold">
                <span className="truncate">{movement.from.label ?? "Origin"}</span>
                <ArrowRight className="size-3 shrink-0" />
                <span className="truncate">{movement.to.label ?? "Destination"}</span>
              </span>
              <span className="mt-px block truncate text-[0.78rem] text-muted-foreground">
                {movement.purpose} ·{" "}
                {movement.person === null
                  ? "no driver"
                  : `driver ${personName(names, movement.person)}`}
                {movement.passengers.length
                  ? ` · passengers ${movement.passengers.map((passenger) => personName(names, passenger.person)).join(", ")}`
                  : ""}
              </span>
            </span>
            <span className="text-right">
              <Badge variant="outline" className="px-1.5 py-0 text-[0.7rem]">{movement.mode}</Badge>
              <span className="mt-px block tabular-nums text-[0.78rem] text-muted-foreground">
                {movement.kilometres.toFixed(1)} km · {duration((movement.end - movement.start) / 60)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
