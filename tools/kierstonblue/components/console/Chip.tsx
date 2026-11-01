"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Building2, Car, Check, Copy, Hash, MapPin, User } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * A value you can do something with.
 *
 * Most of what is on these pages is a fact you read. A few things are handles:
 * a name that opens somebody's record, an address that opens the map, a VIN or
 * a resident id that you are about to paste somewhere else. Underlining them
 * was not enough — half of them are not links at all, and a plain string gives
 * no clue that clicking it will put it on the clipboard.
 *
 * So a handle is a chip: an icon block saying what kind of thing it is, and the
 * value beside it. Following and copying look the same because they answer the
 * same question — this one is live, do something with it — and the icon is what
 * says which. Everything without a chip is just a fact.
 */

const ICONS = {
  person: User,
  place: MapPin,
  building: Building2,
  vehicle: Car,
  id: Hash,
};

export type ChipKind = keyof typeof ICONS;

/**
 * The hue says what kind of thing it is before the icon does: blue for a key
 * you would paste somewhere, green for a person, ochre for a place. Three is
 * the whole vocabulary — a fourth colour would have to mean something, and
 * there is nothing left for it to mean. The hue lives in the mark alone; the
 * body is the page's grey wash with black type.
 */
const TONE: Record<ChipKind, string> = {
  person: "bg-[var(--chip-green)] text-[var(--chip-green-ink)] hover:bg-[var(--chip-green-hi)] "
    + "[--chip-mark:var(--success)]",
  place: "bg-[var(--chip-sand)] text-[var(--chip-sand-ink)] hover:bg-[var(--chip-sand-hi)] "
    + "[--chip-mark:var(--chip-place)]",
  building: "bg-[var(--chip-sand)] text-[var(--chip-sand-ink)] hover:bg-[var(--chip-sand-hi)] "
    + "[--chip-mark:var(--chip-place)]",
  vehicle: "bg-[var(--chip-blue)] text-[var(--chip-blue-ink)] hover:bg-[var(--chip-blue-hi)] "
    + "[--chip-mark:var(--accent-ink)]",
  id: "bg-[var(--chip-blue)] text-[var(--chip-blue-ink)] hover:bg-[var(--chip-blue-hi)] "
    + "[--chip-mark:var(--accent-ink)]",
};

/* Sized to sit inside a line of body text, not to sit on top of it: the mark is
   the cap height of the label beside it, and the chip adds no leading. */
const SHELL = "inline-flex max-w-full items-center overflow-hidden border border-border "
  + "align-[-0.2em] no-underline transition-colors hover:border-[var(--border-strong)] "
  + "hover:no-underline";

/* The hue lives in the mark and nowhere else. A table of forty chips with
   forty tinted bodies is a colour field; forty grey blocks each carrying one
   coloured square down the left edge is still a table. */
const MARK = "grid h-[1.1rem] w-[1.1rem] shrink-0 place-items-center "
  + "bg-[var(--chip-mark)] text-[var(--chip-icon)]";

const BODY = "truncate px-1.5 text-[0.75rem]";

/** A handle that goes somewhere: a person's record, a point on the map. */
export function Chip({ kind, href, children, title, className }: {
  kind: ChipKind;
  href: string;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  const Icon = ICONS[kind];
  return (
    <Link className={cn(SHELL, TONE[kind], className)} href={href} title={title} data-chip={kind}>
      <span className={MARK} aria-hidden>
        <Icon className="size-2.5" />
      </span>
      <span className={BODY}>{children}</span>
    </Link>
  );
}

/** A handle that opens something on the same page: another row, another record. */
export function ButtonChip({ kind = "id", onClick, children, title, className }: {
  kind?: ChipKind;
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  const Icon = ICONS[kind];
  return (
    <button
      type="button"
      className={cn(SHELL, TONE[kind], "cursor-pointer p-0 text-left", className)}
      onClick={onClick}
      title={title}
      data-chip={kind}
    >
      <span className={MARK} aria-hidden>
        <Icon className="size-2.5" />
      </span>
      <span className={BODY}>{children}</span>
    </button>
  );
}

/** A handle that goes on the clipboard: an id, a code, a VIN. */
export function CopyChip({ kind = "id", value, children, className }: {
  kind?: ChipKind;
  value: string;
  /** What is shown, when that is not the value itself. */
  children?: React.ReactNode;
  className?: string;
}) {
  const Icon = ICONS[kind];
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  // A new value means the last confirmation was about something else.
  useEffect(() => { setCopied(false); }, [value]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // No clipboard permission, or an insecure origin: say nothing rather
      // than claim a copy that did not happen.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };

  return (
    <button
      type="button"
      className={cn(SHELL, TONE[kind], "cursor-pointer border-0 p-0 text-left", className)}
      onClick={copy}
      title={`Copy ${value}`}
      data-chip={kind}
    >
      <span className={MARK} aria-hidden>
        {copied ? <Check className="size-2.5" /> : <Icon className="size-2.5" />}
      </span>
      <span className={cn(BODY, "tabular-nums")}>{children ?? value}</span>
      {/* The icon swap is silent to a screen reader, so the change is spoken. */}
      <span className="sr-only" role="status">{copied ? `${value} copied` : ""}</span>
    </button>
  );
}

/** The chip for a place, wherever a lat/lon is all the map needs. */
export function mapHref(lat: number, lon: number, zoom = 18): string {
  return `/map?lat=${lat}&lon=${lon}&zoom=${zoom}`;
}

export function AddressChip({ address, lat, lon, zoom = 18 }: {
  address: string;
  lat: number;
  lon: number;
  zoom?: number;
}) {
  return (
    <Chip kind="place" href={mapHref(lat, lon, zoom)} title="Open address on map">
      {address || "Unnamed place"}
    </Chip>
  );
}

/**
 * A VIN, drawn as the way into that vehicle's day.
 *
 * The register says what the car is; the day file says where it went, who
 * drove it and who was in it. Those are two halves of one object, so every VIN
 * on these pages — in the registry, on an auto loan, in a dossier, on a camera
 * read, on a leg of somebody's day — is the handle that opens the other half.
 */
export function VehicleChip({ vin, date, children }: {
  vin: string;
  /** The date to open on. Omitted, the page takes the most recent day file. */
  date?: string;
  children?: React.ReactNode;
}) {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  return (
    <Chip
      kind="vehicle"
      href={`/vehicles/${encodeURIComponent(vin)}${query}`}
      title={`${vin} movement`}
    >
      {children ?? vin}
    </Chip>
  );
}

/** A household is a first-class browser entity, not an opaque id to copy. */
export function HouseholdChip({ household, children }: {
  household: number;
  children?: React.ReactNode;
}) {
  return (
    <Chip
      kind="building"
      href={`/households?household=${household}`}
      title={`Open household ${household}`}
    >
      {children ?? `Household ${household}`}
    </Chip>
  );
}
