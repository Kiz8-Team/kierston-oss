"use client";

import { ConsoleFilters, type ConsoleField } from "@/components/console/Filters";

/** `advanced` fields sit on a second row behind the strip's "+" button. */
export type FilterField = { advanced?: true } & (
  | { type: "search"; key: string; label: string; placeholder?: string; grow?: true }
  | { type: "select"; key: string; label: string; options: { value: string; label: string }[] }
  | { type: "text"; key: string; label: string; width?: string; inputMode?: React.HTMLAttributes<HTMLInputElement>["inputMode"]; placeholder?: string }
  | { type: "checkbox"; key: string; label: string }
);

/** Old call signature, new console control strip. */
export function FilterBar({ fields, values, onChange }: {
  fields: FilterField[];
  values: Record<string, string | boolean>;
  onChange: (key: string, value: string | boolean) => void;
}) {
  const consoleFields: ConsoleField[] = fields.map((field) => field.type === "search"
    ? { type: "search", key: field.key, label: field.label, placeholder: field.placeholder, advanced: field.advanced }
    : field);
  return (
    <ConsoleFilters
      fields={consoleFields}
      values={values}
      onChange={(patch) => {
        for (const [key, value] of Object.entries(patch)) onChange(key, value);
      }}
    />
  );
}
