"use client";

import { Check, ChevronDown } from "lucide-react";
import { Select as Primitive } from "radix-ui";

import { Micro } from "@/components/console/Panel";
import { cn } from "@/lib/utils";

/**
 * A dropdown that belongs to the console rather than to the operating system.
 *
 * A native `<select>` can be given a border and nothing else: the list it opens
 * is drawn by the OS, in the OS's colours, at the OS's size, and on a near-black
 * page it arrives as a white rectangle with the wrong type in it. This is the
 * same control with the list under our own paint — same surface as a panel, same
 * hairline, same measure — and it keeps the keyboard behaviour that made the
 * native one worth using: type to jump, arrows to walk, Enter to take, Escape to
 * leave it alone.
 *
 * The trigger's width is fixed by its widest option, not by the current one, so
 * changing the value never moves the controls beside it.
 */

export interface ConsoleOption {
  value: string;
  label: string;
}

export function ConsoleSelect({
  label,
  options,
  value,
  onChange,
  className,
  /** Draw the label inside the control, the way the filter row does. */
  inline = true,
}: {
  label: string;
  options: ConsoleOption[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
  inline?: boolean;
}) {
  const current = options.find((option) => option.value === value) ?? options[0];

  return (
    <Primitive.Root value={current?.value} onValueChange={onChange}>
      <Primitive.Trigger
        className={cn(
          "group flex h-7 shrink-0 cursor-pointer items-center gap-1.5 border border-[var(--border-strong)]",
          "bg-background pr-2 text-[0.75rem] text-foreground outline-none",
          inline ? "pl-2" : "pl-2.5",
          "hover:border-rule data-[state=open]:border-rule",
          className,
        )}
        aria-label={label}
      >
        {inline ? <Micro className="text-[0.58rem]">{label}</Micro> : null}
        {/* The widest option is laid out invisibly under the current one, which
            is what stops the row shuffling every time the value changes. */}
        <span className="grid">
          <span className="col-start-1 row-start-1 truncate text-left">
            <Primitive.Value />
          </span>
          <span aria-hidden className="col-start-1 row-start-1 h-0 overflow-hidden opacity-0">
            {options.map((option) => (
              <span key={option.value} className="block">{option.label}</span>
            ))}
          </span>
        </span>
        <Primitive.Icon asChild>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground group-data-[state=open]:text-foreground" />
        </Primitive.Icon>
      </Primitive.Trigger>

      <Primitive.Portal>
        <Primitive.Content
          position="popper"
          sideOffset={4}
          className={cn(
            "z-50 max-h-[min(20rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)]",
            "overflow-y-auto border border-rule bg-popover p-0",
            "shadow-[var(--shadow-float)]",
          )}
        >
          <Primitive.Viewport>
            {options.map((option) => (
              <Primitive.Item
                key={option.value}
                value={option.value}
                className={cn(
                  "relative flex h-6 cursor-pointer items-center pr-2 pl-6",
                  "text-[0.75rem] text-foreground outline-none select-none",
                  "data-[highlighted]:bg-primary data-[highlighted]:text-primary-foreground",
                )}
              >
                <Primitive.ItemIndicator className="absolute left-1.5 grid place-items-center">
                  <Check className="size-3" />
                </Primitive.ItemIndicator>
                <Primitive.ItemText>{option.label}</Primitive.ItemText>
              </Primitive.Item>
            ))}
          </Primitive.Viewport>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
