"use client";

import { CopyChip, HouseholdChip, VehicleChip, type ChipKind } from "@/components/console/Chip";
import { PersonLink } from "@/components/PersonLink";
import { useNames } from "@/components/useNames";
import { humanise, num, percent, rate as asRate, usd, usdExact } from "@/lib/format";
import type { FieldKind, RecordTable, Value } from "@/lib/records";
import { Facts } from "@/components/browse/detail";

/**
 * How a record value is drawn, wherever it appears.
 *
 * Shared by the record browsers and the full personal record, so a mortgage
 * rate looks the same in a table cell as it does in a dossier. The formatting
 * comes from the field kind the packer wrote into the header — the caller does
 * not have to know that `balance` is money and `rate` is a percentage.
 */

/**
 * A resident id, drawn as the person's name.
 *
 * Its own component rather than a branch inside ValueCell so that the names
 * hook runs only where a person chip is actually drawn. ValueCell renders
 * every cell of every table, and a hook at the top of it would subscribe a few
 * hundred cells to a file none of them read.
 */
function PersonChip({ person }: { person: number }) {
  return <PersonLink names={useNames()} person={person} />;
}

export function ValueCell({ kind, value, format, field, rich = false }: {
  kind: FieldKind;
  value: Value;
  /** The field's name, which is what says whether an id is a VIN or a docket. */
  field?: string;
  /**
   * Draw the values you can act on as chips — an id you would paste elsewhere
   * becomes a copy handle. Off in tables, where a row is scanned rather than
   * used, and where a chip in every cell would be all anyone could see.
   */
  rich?: boolean;
  /**
   * `money` rounds to whole dollars, `exact` keeps the cents, and `share`
   * reads the number as a fraction of one rather than as a percentage already.
   * The last one exists because the packer has a single float kind for both:
   * a mortgage's 7.248 means 7.248%, and a payment profile's 0.19 means 19%,
   * and only the field knows which it wrote.
   */
  format?: "money" | "exact" | "share";
}) {
  if (Array.isArray(value)) return <>{value.map(humanise).join(", ")}</>;
  if (typeof value === "boolean") {
    return value ? <>yes</> : <span className="text-muted-foreground">no</span>;
  }
  if (typeof value === "number") {
    if (format === "money") return <span className="tabular-nums">{usd(value)}</span>;
    if (format === "exact") return <span className="tabular-nums">{usdExact(value)}</span>;
    if (format === "share") return <span className="tabular-nums">{percent(value)}</span>;
    if (kind === "money") return <span className="tabular-nums">{usdExact(value)}</span>;
    if (kind === "rate") return <span className="tabular-nums">{asRate(value)}</span>;
    // A year and a deed book number are printed, not counted — no thousands
    // separator on 2017, and no currency on a page number.
    if (kind === "year") return <span className="tabular-nums">{value}</span>;
    if (kind === "id") {
      if (rich && field?.toLowerCase().includes("household")) {
        return <HouseholdChip household={value} />;
      }
      if (rich && idKind(field) === "person") return <PersonChip person={value} />;
      return rich
        ? <CopyChip kind={idKind(field)} value={String(value)} />
        : <span className="tabular-nums">{value}</span>;
    }
    return <span className="tabular-nums">{num(value)}</span>;
  }
  if (kind === "id" && rich && value !== null) {
    // A VIN is a join, not a string to paste: it leads to that vehicle's day.
    // A plate is not — the day file is keyed by VIN, and a plate reaches the
    // register instead.
    if (field?.toLowerCase().includes("vin")) return <VehicleChip vin={String(value)} />;
    if (field?.toLowerCase().includes("household")) {
      const household = Number(value);
      if (Number.isSafeInteger(household) && household >= 0) {
        return <HouseholdChip household={household} />;
      }
    }
    if (idKind(field) === "person") {
      // A person id arriving as a string still has to be a resident number to
      // be a link at all — anything else is left as a handle to copy.
      const person = Number(value);
      if (Number.isSafeInteger(person) && person >= 0) return <PersonChip person={person} />;
    }
    return <CopyChip kind={idKind(field)} value={String(value)} />;
  }
  if (kind === "date" || kind === "str") return <span className="tabular-nums">{value}</span>;
  return <>{humanise(value)}</>;
}

/**
 * The id fields that hold a resident id under some other name.
 *
 * `person` and `for_person` give themselves away; these do not, and each was
 * rendering as a number to copy rather than as the person it stands for. A
 * subscription's `user` and `account_holder` are the pair worth having — they
 * differ for one line in six, and reading who actually pays for a phone should
 * not mean pasting an id into the record page by hand.
 *
 * `owner` is deliberately absent. A vehicle's owner is a resident *or* an
 * organisation that resolves through fleet.json, so linking it to /record
 * would send a reader to a person who does not exist for every fleet car.
 */
const PERSON_ID_FIELDS = new Set([
  "user", "account_holder", "payer", "alt_payer",
]);

/** What an id is a handle for, as far as its field name gives it away. */
function idKind(field?: string): ChipKind {
  const name = field ?? "";
  if (name.includes("vin") || name.includes("plate")) return "vehicle";
  if (name.includes("person") || name.includes("resident")) return "person";
  if (PERSON_ID_FIELDS.has(name)) return "person";
  return "id";
}

/** Whether a value is worth a line at all. */
export function isBlank(value: Value): boolean {
  return value === null || (Array.isArray(value) && value.length === 0);
}

/**
 * Every field of one row as a label/value list.
 *
 * `skip` drops the fields the surrounding context already states — a dossier
 * has said whose record this is, so it does not repeat the resident id on
 * every one of their credit cards.
 *
 * `formats` carries the per-field overrides the field kind cannot supply, so a
 * cash preference reads as 19% here as well as in the table it was clicked in.
 */
export function FieldRows({
  table, index, skip = [], hideBlank = false, formats, rich = true,
}: {
  table: RecordTable;
  index: number;
  skip?: string[];
  hideBlank?: boolean;
  formats?: Record<string, "money" | "exact" | "share">;
  /** Actionable identifiers are chips in record sidebars by default. */
  rich?: boolean;
}) {
  return (
    <Facts>
      {table.fieldNames.map((field) => {
        if (skip.includes(field)) return null;
        const value = table.value(field, index);
        const blank = isBlank(value);
        if (blank && hideBlank) return null;
        return (
          <div key={field}>
            <span>{humanise(field)}</span>
            <span>
              {blank
                ? <span className="text-muted-foreground">—</span>
                : (
                  <ValueCell
                    kind={table.kindOf(field)!}
                    value={value}
                    format={formats?.[field]}
                    field={field}
                    rich={rich}
                  />
                )}
            </span>
          </div>
        );
      })}
    </Facts>
  );
}
