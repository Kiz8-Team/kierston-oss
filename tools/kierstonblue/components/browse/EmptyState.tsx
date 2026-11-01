import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function EmptyState({
  title,
  children,
  action,
  className,
}: {
  title?: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("px-4 py-9 text-center text-sm text-muted-foreground", className)}>
      {title ? (
        <strong className="mb-1.5 block text-[0.9rem] text-foreground">{title}</strong>
      ) : null}
      {children ? (
        <div className="mx-auto max-w-md text-pretty text-muted-foreground [&_p]:m-0">
          {children}
        </div>
      ) : null}
      {action ? <div className="mt-3.5 flex justify-center gap-1.5">{action}</div> : null}
    </div>
  );
}

export function StatusText({
  state,
  children,
}: {
  state?: "error" | "busy" | "ok";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "text-[0.75rem]",
        state === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function ClearFiltersButton({ onClick }: { onClick: () => void }) {
  return (
    <Button type="button" variant="outline" size="xs" onClick={onClick}>
      Clear filters
    </Button>
  );
}
