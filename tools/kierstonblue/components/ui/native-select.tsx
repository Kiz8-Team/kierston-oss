import * as React from "react";

import { cn } from "@/lib/utils";

/** Dense native select matching Input — better for long facet lists than Radix Select. */
function NativeSelect({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="native-select"
      className={cn(
        // Same footprint and paint as Input, Button and ConsoleSelect: every
        // control on a query row is 1.75rem tall, hairline-bordered and sunken,
        // so a row of them reads as one strip rather than a stack of widgets.
        "h-7 w-full min-w-0 border border-border bg-[var(--panel-sunken)] px-2 py-0 text-[0.78rem] tabular-nums outline-none transition-colors",
        "focus-visible:border-primary focus-visible:outline-none",
        "disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50",
        // A select left on "Any" and one narrowing the table look identical
        // otherwise, which is how a filter gets forgotten about.
        "data-[set=true]:border-primary/50 data-[set=true]:bg-accent data-[set=true]:font-medium",
        className,
      )}
      {...props}
    />
  );
}

export { NativeSelect };
