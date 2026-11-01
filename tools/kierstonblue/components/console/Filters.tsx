"use client";

import { useState } from "react";
import { Plus, Search, X } from "lucide-react";
import { DropdownMenu } from "radix-ui";

import { Micro } from "@/components/console/Panel";
import { ConsoleSelect } from "@/components/console/Select";
import { cn } from "@/lib/utils";

/**
 * The query row — one strip of controls across the top of a browser.
 *
 * Every control here has a fixed footprint. Nothing appears, disappears or
 * changes weight when it is used: a segment's selection is a background, the
 * clear button is always present and only changes colour, and the row never
 * grows a second line. A control that moves the table when you touch it makes
 * the whole page feel unreliable, and this row is touched constantly.
 *
 * A field marked `advanced` is not on the strip. A fixed "+" button lists the
 * ones not yet in use; picking one puts that single control on a second row,
 * where it stays until Clear. A field that already holds a value is on the row
 * regardless, so nothing filters the table invisibly.
 */

type Advanced = { advanced?: true };

export type ConsoleField = Advanced & (
  | { type: "search"; key: string; label: string; placeholder?: string }
  | { type: "text"; key: string; label: string; placeholder?: string; width?: string; inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"] }
  | { type: "checkbox"; key: string; label: string }
  | { type: "segment"; key: string; label: string; options: { value: string; label: string }[] }
  | { type: "select"; key: string; label: string; options: { value: string; label: string }[] }
  | {
      type: "range";
      /** Two keys, one control: the low bound and the high bound. */
      minKey: string;
      maxKey: string;
      label: string;
    }
);

export type FilterValues = Record<string, string | boolean>;

/** The value a control holds when it is not narrowing anything. */
function cleared(field: ConsoleField): Record<string, string | boolean> {
  switch (field.type) {
    case "search":
    case "text":
      return { [field.key]: "" };
    case "checkbox":
      return { [field.key]: false };
    case "range":
      return { [field.minKey]: "", [field.maxKey]: "" };
    default:
      return { [field.key]: field.options[0]?.value ?? "" };
  }
}

function isSet(field: ConsoleField, values: FilterValues): boolean {
  if (field.type === "range") {
    return Boolean(String(values[field.minKey] ?? "").trim() || String(values[field.maxKey] ?? "").trim());
  }
  if (field.type === "checkbox") return values[field.key] === true;
  const value = String(values[field.key] ?? "").trim();
  return Boolean(value) && value !== cleared(field)[field.key];
}

const SHELL = "flex h-7 shrink-0 items-center border bg-background";

export function ConsoleFilters({
  fields,
  values,
  onChange,
}: {
  fields: ConsoleField[];
  values: FilterValues;
  onChange: (patch: Record<string, string | boolean>) => void;
}) {
  const [added, setAdded] = useState<string[]>([]);
  const anySet = fields.some((field) => isSet(field, values));

  const clearAll = () => {
    const patch: Record<string, string | boolean> = {};
    for (const field of fields) Object.assign(patch, cleared(field));
    onChange(patch);
    setAdded([]);
  };

  const render = (field: ConsoleField) => {
    if (field.type === "checkbox") {
      const on = values[field.key] === true;
      return (
        <button
          key={field.key}
          type="button"
          aria-pressed={on}
          className={cn(
            SHELL,
            "gap-2 px-2.5 text-[0.75rem] transition-colors",
            on ? "border-rule bg-primary text-primary-foreground" : "border-[var(--border-strong)] text-muted-foreground hover:border-rule hover:text-foreground",
          )}
          onClick={() => onChange({ [field.key]: !on })}
        >
          <span className={cn("size-1.5", on ? "bg-primary-foreground" : "bg-muted-foreground/40")} />
          {field.label}
        </button>
      );
    }

    if (field.type === "text") {
      const value = String(values[field.key] ?? "");
      return (
        <label key={field.key} className={cn(SHELL, "border-[var(--border-strong)] pl-2 focus-within:border-rule")}>
          <Micro className="text-[0.58rem]">{field.label}</Micro>
          <input
            className="h-6 bg-transparent px-2 text-[0.75rem] tabular-nums outline-none placeholder:text-muted-foreground/60"
            style={field.width ? { width: field.width } : undefined}
            inputMode={field.inputMode}
            placeholder={field.placeholder}
            value={value}
            onChange={(event) => onChange({ [field.key]: event.target.value })}
          />
        </label>
      );
    }

    if (field.type === "search") {
      const value = String(values[field.key] ?? "");
      return (
        <span key={field.key} className="relative flex h-7 min-w-[15rem] flex-1 items-center">
          <Search
            className="pointer-events-none absolute left-2.5 size-3.5 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            className={cn(
              "h-7 w-full border border-[var(--border-strong)] bg-background",
              "pr-8 pl-8 text-[0.78rem] text-foreground outline-none",
              "placeholder:text-muted-foreground/70",
              "focus-visible:border-rule focus-visible:outline-none",
              "[&::-webkit-search-cancel-button]:hidden",
            )}
            placeholder={field.placeholder ?? field.label}
            aria-label={field.label}
            value={value}
            onChange={(event) => onChange({ [field.key]: event.target.value })}
            onKeyDown={(event) => {
              // Escape clears the box rather than only blurring it, which is
              // what every other search field on the machine does.
              if (event.key === "Escape" && value) {
                event.preventDefault();
                onChange({ [field.key]: "" });
              }
            }}
          />
          <button
            type="button"
            className={cn(
              "absolute right-1.5 grid size-5 place-items-center",
              value
                ? "text-muted-foreground hover:bg-muted hover:text-foreground"
                : "pointer-events-none opacity-0",
            )}
            tabIndex={value ? 0 : -1}
            onClick={() => onChange({ [field.key]: "" })}
            aria-label={`Clear ${field.label.toLowerCase()}`}
          >
            <X className="size-3" />
          </button>
        </span>
      );
    }

    if (field.type === "segment") {
      const value = String(values[field.key] ?? field.options[0]?.value ?? "");
      return (
        <span
          key={field.key}
          className={cn(SHELL, "border-[var(--border-strong)]")}
          role="group"
          aria-label={field.label}
        >
          <Micro className="px-2 text-[0.58rem]">{field.label}</Micro>
          {field.options.map((option) => {
            const on = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={on}
                // No weight change on selection: bold text is wider than
                // regular, and every button after it would move.
                className={cn(
                  "h-full min-w-7 px-2 text-[0.74rem] tabular-nums transition-colors",
                  on
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
                onClick={() => onChange({ [field.key]: option.value })}
              >
                {option.label}
              </button>
            );
          })}
        </span>
      );
    }

    if (field.type === "range") {
      const set = isSet(field, values);
      return (
        <span
          key={field.minKey}
          className={cn(SHELL, "pl-2", set ? "border-rule" : "border-[var(--border-strong)]")}
        >
          <Micro className="text-[0.58rem]">{field.label}</Micro>
          <input
            className={RANGE_INPUT}
            inputMode="numeric"
            aria-label={`${field.label} from`}
            placeholder="min"
            value={String(values[field.minKey] ?? "")}
            onChange={(event) => onChange({ [field.minKey]: event.target.value })}
          />
          <span className="text-muted-foreground/60" aria-hidden>–</span>
          <input
            className={RANGE_INPUT}
            inputMode="numeric"
            aria-label={`${field.label} to`}
            placeholder="max"
            value={String(values[field.maxKey] ?? "")}
            onChange={(event) => onChange({ [field.maxKey]: event.target.value })}
          />
        </span>
      );
    }

    const value = String(values[field.key] ?? field.options[0]?.value ?? "");
    const set = isSet(field, values);
    return (
      <ConsoleSelect
        key={field.key}
        label={field.label}
        options={field.options}
        value={value}
        onChange={(next) => onChange({ [field.key]: next })}
        className={set ? "border-rule" : undefined}
      />
    );
  };

  const primary = fields.filter((field) => !field.advanced);
  const advanced = fields.filter((field) => field.advanced);
  const keyOf = (field: ConsoleField) => (field.type === "range" ? field.minKey : field.key);
  const shown = advanced.filter((field) => added.includes(keyOf(field)) || isSet(field, values));
  const hidden = advanced.filter((field) => !shown.includes(field));

  return (
    <div className="grid gap-1.5">
    <div className="flex flex-wrap items-center gap-1.5">
      {primary.map(render)}

      {hidden.length > 0 ? (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger
            aria-label="Add filter"
            className={cn(
              SHELL,
              "w-7 justify-center border-[var(--border-strong)] text-muted-foreground transition-colors",
              "hover:border-rule hover:text-foreground data-[state=open]:border-rule data-[state=open]:text-foreground",
            )}
          >
            <Plus className="size-3.5" />
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              sideOffset={4}
              className="z-50 min-w-[10rem] border border-rule bg-popover p-0 shadow-[var(--shadow-float)]"
            >
              {hidden.map((field) => (
                <DropdownMenu.Item
                  key={keyOf(field)}
                  className={cn(
                    "flex h-6 cursor-pointer items-center px-2.5 text-[0.75rem] text-foreground outline-none select-none",
                    "data-[highlighted]:bg-primary data-[highlighted]:text-primary-foreground",
                  )}
                  onSelect={() => setAdded((current) => [...current, keyOf(field)])}
                >
                  {field.label}
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      ) : null}

      <button
        type="button"
        className={cn(
          "h-7 shrink-0 px-2 text-[0.76rem] transition-colors",
          anySet
            ? "text-muted-foreground hover:bg-muted hover:text-foreground"
            : "pointer-events-none text-muted-foreground/25",
        )}
        tabIndex={anySet ? 0 : -1}
        onClick={clearAll}
      >
        Clear
      </button>

    </div>

    {shown.length > 0 ? (
      <div className="flex flex-wrap items-center gap-1.5">
        {shown.map(render)}
      </div>
    ) : null}
    </div>
  );
}

const RANGE_INPUT = "h-6 w-[4.5rem] bg-transparent px-1.5 text-[0.75rem] tabular-nums "
  + "outline-none placeholder:text-muted-foreground/60";
