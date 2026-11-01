"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";

import { CommandMenuTrigger } from "@/components/CommandMenu";
import { NAV, isCurrent } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * The section rail: the instrument's nav bay, in two widths.
 *
 * It is a list of destinations and nothing else — no padding around the
 * items, no gap between them, no inset highlight. Every row is the full width
 * of the bay and 26px tall, divided from the group above it by a hairline, so
 * the bay reads as a stack of hard cells rather than a floating menu. The
 * current page is filled black with white type, the way the site's own side
 * navigation marks the open entry: this is where you are.
 *
 * Collapsed it keeps the icons and drops everything that needs room. That is
 * deliberate — the icons are the part a reader navigates by once they know the
 * app, and a map or a wide table is the reason anybody wants the width back.
 *
 * The choice is remembered per browser, read after mount rather than during
 * render: the server has no way to know it, and rendering the wide rail and
 * then narrowing it is the only honest order.
 */

const STORAGE_KEY = "kierstonblue.rail.collapsed";

export function Rail() {
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      // Private windows and blocked site data: the rail simply stays open.
    }
  }, []);

  const toggle = () => setCollapsed((current) => {
    const next = !current;
    try { window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0"); } catch { /* as above */ }
    return next;
  });

  return (
    <nav
      className={cn(
        "flex min-h-0 flex-col bg-sidebar text-sidebar-foreground",
        "border-r border-border",
        "[&_:focus-visible]:outline-[var(--sidebar-ring)]",
        collapsed ? "w-[2.75rem]" : "w-[14rem]",
        "max-[51.25rem]:w-full max-[51.25rem]:border-r-0 max-[51.25rem]:border-b",
      )}
      aria-label="Sections"
      data-collapsed={collapsed}
    >
      <div className="flex h-8 shrink-0 items-stretch border-b border-border">
        <div className={cn("flex min-w-0 flex-1 items-center", collapsed && "hidden")}>
          <CommandMenuTrigger />
        </div>
        <button
          type="button"
          className={cn(
            "grid w-8 shrink-0 place-items-center text-[var(--rail-muted)]",
            "border-border transition-colors hover:bg-sidebar-accent hover:text-foreground",
            collapsed ? "flex-1" : "border-l",
          )}
          onClick={toggle}
          title={collapsed ? "Expand rail" : "Collapse rail"}
          aria-label={collapsed ? "Expand rail" : "Collapse rail"}
          aria-expanded={!collapsed}
        >
          {collapsed
            ? <PanelLeftOpen className="size-3.5" aria-hidden />
            : <PanelLeftClose className="size-3.5" aria-hidden />}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden max-[51.25rem]:max-h-[50vh]">
        <Suspense fallback={<RailLinks pathname="" search="" collapsed={collapsed} />}>
          <RailLinksLive collapsed={collapsed} />
        </Suspense>
      </div>
    </nav>
  );
}

function RailLinksLive({ collapsed }: { collapsed: boolean }) {
  const pathname = usePathname();
  const search = useSearchParams().toString();
  return <RailLinks pathname={pathname} search={search} collapsed={collapsed} />;
}

function RailLinks({ pathname, search, collapsed }: {
  pathname: string;
  search: string;
  collapsed: boolean;
}) {
  return (
    <>
      {NAV.map((section) => (
        <div key={section.title} className="border-b border-sidebar-border last:border-b-0">
          {/* Collapsed, a heading has nothing to say and the group's own
              hairline says it better: the groups still read, in a fifth of
              the width. */}
          {collapsed ? null : (
            <div className="flex h-7 items-end px-2.5 pb-1">
              <span className="micro text-[0.64rem]">
                {section.title}
              </span>
            </div>
          )}

          {section.links.map((link) => {
            const active = isCurrent(link.href, pathname, search);
            return (
              <Link
                key={link.href}
                className={cn(
                  "group relative flex h-[1.8rem] items-center text-[0.8rem]",
                  "no-underline transition-colors hover:no-underline",
                  collapsed ? "justify-center" : "gap-2 pr-2 pl-2.5",
                  active
                    ? "bg-primary text-primary-foreground"
                    : "text-sidebar-foreground hover:bg-sidebar-accent",
                )}
                href={link.href}
                data-active={active}
                aria-current={active ? "page" : undefined}
                title={collapsed ? `${section.title} · ${link.label}` : undefined}
              >
                <link.icon
                  className={cn(
                    "size-3.5 shrink-0 transition-colors",
                    active ? "text-primary-foreground" : "text-[var(--rail-muted)] group-hover:text-foreground",
                  )}
                  aria-hidden
                />
                <span className={collapsed ? "sr-only" : "truncate"}>{link.label}</span>
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}
