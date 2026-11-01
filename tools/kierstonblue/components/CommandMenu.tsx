"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock, CornerDownLeft, Search, UserRound } from "lucide-react";

import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { getIdentity } from "@/lib/datasets";
import type { Identity } from "@/lib/identity";
import { NAV_LINKS, SECTION_OF, type NavLink } from "@/lib/nav";
import { useRecentPeople } from "@/lib/recent";
import { cn } from "@/lib/utils";

/**
 * ⌘K — go anywhere, or find anyone by name.
 *
 * Before this, reaching a named resident meant knowing which of nine browsers
 * listed them, filtering it, and clicking through; and reaching a page meant
 * finding it in a rail of twenty entries. Both are one keystroke now.
 *
 * The palette does its own filtering rather than cmdk's. Two reasons: the
 * people list is 121,060 names, so only the first handful may ever become DOM
 * nodes, and a search that puts pages above people needs an ordering cmdk's
 * scorer does not know about.
 *
 * identity.bin is 20-odd MB, so it is not loaded until the palette is first
 * opened — a session that never searches for a person never pays for it. The
 * module cache in lib/datasets means the pages that need it anyway share the
 * same copy.
 */

const PERSON_LIMIT = 8;

/**
 * The palette is mounted once in the root layout, so anything that wants to
 * open it — the rail's search field, an empty state's "find someone" — needs a
 * handle on it that is not a React tree away. One module-level setter, claimed
 * by the mounted palette, is less machinery than a context provider wrapping
 * every page for a single boolean.
 */
let openMenu: (() => void) | null = null;

export function openCommandMenu(): void {
  openMenu?.();
}

export function CommandMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [loadingNames, setLoadingNames] = useState(false);
  const recent = useRecentPeople();
  const requested = useRef(false);

  useEffect(() => {
    openMenu = () => setOpen(true);
    return () => { openMenu = null; };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
        return;
      }
      // A bare "/" is the other search shortcut people try, but only when they
      // are not already typing into something.
      if (event.key === "/" && !meta && !isTyping(event.target)) {
        event.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Names arrive on first open, not on mount: this component is in the root
  // layout, and every page would otherwise start by fetching the biggest file.
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    setLoadingNames(true);
    getIdentity()
      .then(setIdentity)
      .catch(() => { /* No identity file: pages still work, search does not. */ })
      .finally(() => setLoadingNames(false));
  }, [open]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery("");
      router.push(href);
    },
    [router],
  );

  const needle = query.trim().toLowerCase();

  const pages = useMemo(() => matchPages(needle), [needle]);
  const people = useMemo(() => matchPeople(identity, needle), [identity, needle]);

  const showRecent = !needle && recent.length > 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Search"
      description="Pages and residents"
      shouldFilter={false}
      className="top-[18%] translate-y-0 sm:max-w-[34rem]"
      showCloseButton={false}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder="Pages and residents"
      />
      <CommandList className="max-h-[24rem]">
        <CommandEmpty>
          {loadingNames ? (
            <span className="text-muted-foreground">Loading…</span>
          ) : (
            <span className="text-muted-foreground">No matches</span>
          )}
        </CommandEmpty>

        {pages.length ? (
          <CommandGroup heading="Pages">
            {pages.map((link) => (
              <CommandItem
                key={link.href}
                value={link.href}
                onSelect={() => go(link.href)}
                className="gap-2.5"
              >
                <link.icon className="text-muted-foreground" />
                <span className="font-medium">{link.label}</span>
                <span className="truncate text-[0.72rem] text-muted-foreground">
                  {link.hint}
                </span>
                <span className="ml-auto shrink-0 text-[0.68rem] text-muted-foreground">
                  {SECTION_OF[link.href]}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ) : null}

        {people.length ? (
          <>
            {pages.length ? <CommandSeparator /> : null}
            <CommandGroup heading="Residents">
              {people.map((person) => (
                <PersonItem
                  key={person}
                  identity={identity!}
                  person={person}
                  onSelect={() => go(`/record?person=${person}`)}
                />
              ))}
            </CommandGroup>
          </>
        ) : null}

        {showRecent ? (
          <>
            {pages.length ? <CommandSeparator /> : null}
            <CommandGroup heading="Recent">
              {recent.map((person) => (
                <PersonItem
                  key={person}
                  identity={identity}
                  person={person}
                  icon={Clock}
                  onSelect={() => go(`/record?person=${person}`)}
                />
              ))}
            </CommandGroup>
          </>
        ) : null}

        {needle && loadingNames ? (
          <div className="px-3 py-2 text-[0.72rem] text-muted-foreground">
            Loading residents…
          </div>
        ) : null}
      </CommandList>

      <div className="flex items-center gap-3 border-t px-3 py-1.5 text-[0.68rem] text-muted-foreground">
        <span className="flex items-center gap-1">
          <CornerDownLeft className="size-3" /> open
        </span>
        <span className="flex items-center gap-1">
          <span className="cap">esc</span> close
        </span>
      </div>
    </CommandDialog>
  );
}

function PersonItem({
  identity,
  person,
  onSelect,
  icon: Icon = UserRound,
}: {
  identity: Identity | null;
  person: number;
  onSelect: () => void;
  icon?: typeof UserRound;
}) {
  const known = identity?.knows(person) ?? false;
  return (
    <CommandItem value={`person-${person}`} onSelect={onSelect} className="gap-2.5">
      <Icon className="text-muted-foreground" />
      <span className="truncate font-medium">
        {known ? identity!.name(person) : `Resident ${person}`}
      </span>
      {known && identity!.birthYear(person) ? (
        <span className="shrink-0 text-[0.72rem] text-muted-foreground">
          born {identity!.birthYear(person)}
        </span>
      ) : null}
      <span className="ml-auto shrink-0 font-sans text-[0.68rem] text-muted-foreground">
        {person}
      </span>
    </CommandItem>
  );
}

/** Pages whose label, hint or keywords contain every word typed. */
function matchPages(needle: string): NavLink[] {
  if (!needle) return NAV_LINKS;
  const words = needle.split(/\s+/).filter(Boolean);
  const scored = NAV_LINKS.map((link) => {
    const haystack = `${link.label} ${link.hint} ${link.keywords ?? ""}`.toLowerCase();
    if (!words.every((word) => haystack.includes(word))) return null;
    // A label that starts with what was typed is what was meant.
    const label = link.label.toLowerCase();
    const rank = label.startsWith(needle) ? 0 : label.includes(needle) ? 1 : 2;
    return { link, rank };
  }).filter((entry): entry is { link: NavLink; rank: number } => entry !== null);
  scored.sort((a, b) => a.rank - b.rank);
  return scored.map((entry) => entry.link);
}

/**
 * Residents matching a name fragment, or the one resident matching an id.
 *
 * The scan is a plain `includes` over the flattened name array — 121,060
 * strings, which a modern engine walks in a couple of milliseconds, and it
 * stops at the first eight hits rather than collecting them all.
 */
function matchPeople(identity: Identity | null, needle: string): number[] {
  if (!identity || !needle) return [];

  // An id is exact, so one digit is enough to act on; a name fragment of one
  // letter would match a third of the city and is not worth scanning for.
  if (/^\d+$/.test(needle)) {
    const person = Number(needle);
    return identity.knows(person) ? [person] : [];
  }
  if (needle.length < 2) return [];

  const names = identity.searchNames;
  const found: number[] = [];
  // Whole-word starts first — "smith" should lead with the Smiths, not with
  // everyone whose street or middle name happens to contain it.
  for (let i = 0; i < names.length && found.length < PERSON_LIMIT; i += 1) {
    if (names[i].startsWith(needle)) found.push(i);
  }
  if (found.length < PERSON_LIMIT) {
    const seen = new Set(found);
    for (let i = 0; i < names.length && found.length < PERSON_LIMIT; i += 1) {
      if (!seen.has(i) && names[i].includes(needle)) found.push(i);
    }
  }
  return found;
}

function isTyping(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || node.isContentEditable;
}

/**
 * The rail's way in for people who do not know the shortcut.
 *
 * It renders as a search field rather than a button because that is what it
 * does, and a field is the thing the eye looks for when it wants to search.
 */
export function CommandMenuTrigger({ className, compact = false }: {
  className?: string;
  /** Icon only, for the collapsed rail: no label, no shortcut hint. */
  compact?: boolean;
}) {
  const [mac, setMac] = useState(true);

  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  }, []);

  const hint = `Search (${mac ? "⌘" : "Ctrl+"}K)`;
  return (
    <button
      type="button"
      className={cn(
        "flex h-full min-h-8 items-center bg-transparent",
        "text-[0.78rem] text-[var(--rail-muted)]",
        "transition-colors hover:bg-sidebar-accent hover:text-foreground",
        compact ? "w-8 justify-center" : "w-full gap-2 px-2.5",
        className,
      )}
      onClick={openCommandMenu}
      title={compact ? hint : undefined}
      aria-label={compact ? hint : undefined}
    >
      <Search className="size-3.5 shrink-0" />
      {compact ? null : (
        <>
          <span className="truncate">Search</span>
          <kbd className="cap ml-auto">
            {mac ? "⌘K" : "^K"}
          </kbd>
        </>
      )}
    </button>
  );
}
