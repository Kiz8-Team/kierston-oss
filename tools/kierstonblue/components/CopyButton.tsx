"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Copy one value — an id, an address, a docket number — to the clipboard.
 *
 * These datasets are keys as much as they are prose: a resident id gets pasted
 * into another browser's search box, a VIN gets grepped for in the generator's
 * output. Selecting a number out of a table row by hand is fiddly and easy to
 * get one digit wrong, so the values worth carrying elsewhere get a button.
 */
export function CopyButton({
  value,
  label = "Copy",
  className,
  size = "xs",
}: {
  value: string;
  /** What the button says, and what its title reads as. */
  label?: string;
  className?: string;
  size?: React.ComponentProps<typeof Button>["size"];
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // No clipboard permission (or an insecure origin): say nothing rather
      // than claim a copy that did not happen.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1400);
  };

  return (
    <Button
      type="button"
      variant="outline"
      size={size}
      className={className}
      onClick={copy}
      title={`${label}: ${value}`}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? "Copied" : label}
      {/* The icon swap is silent to a screen reader, so the change is spoken. */}
      <span className="sr-only" role="status">
        {copied ? `${value} copied to clipboard` : ""}
      </span>
    </Button>
  );
}
