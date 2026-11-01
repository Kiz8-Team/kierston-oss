"use client";

import { createContext, Suspense, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import type { CityOption } from "@/app/api/cities/route";
import type { DaySummary } from "@/lib/server/day";

/**
 * The city build and the day every page is looking at, chosen once in the
 * header.
 *
 * Both live in cookies so the server sees them too: the build decides which
 * folder every route reads (lib/server/city.ts), and the day is what a page
 * opens on when its URL names none. A `?date=` in the URL still wins, so a link
 * to a particular day keeps meaning that day, and following one moves the
 * header with it.
 *
 * Switching build reloads the page. Everything loaded so far — the population,
 * the records, the module-level caches in lib/datasets.ts — belongs to the old
 * one, and a reload is the one way to drop all of it at once.
 */

const DAY_COOKIE = "kb-day";

interface Scope {
  cities: CityOption[] | null;
  city: CityOption | null;
  /** Days of the current build, newest first; null while loading. */
  days: DaySummary[] | null;
  /** The chosen day, or "" when the build has none. */
  day: string;
  error: string | null;
  setDay: (day: string) => void;
  /** Select a build by path. Resolves to an error, or reloads. */
  selectCity: (dir: string) => Promise<string | null>;
}

const ScopeContext = createContext<Scope | null>(null);

function readCookie(name: string): string | null {
  const match = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function writeCookie(name: string, value: string): void {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=31536000; samesite=lax`;
}

async function json<T>(response: Response): Promise<T> {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload as T;
}

export function ScopeProvider({ children }: { children: React.ReactNode }) {
  const [cities, setCities] = useState<CityOption[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [days, setDays] = useState<DaySummary[] | null>(null);
  const [day, setDayState] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/cities")
      .then((response) => json<{ current: string; cities: CityOption[] }>(response))
      .then((payload) => { setCities(payload.cities); setCurrent(payload.current); })
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    fetch("/api/days")
      .then((response) => json<{ days: DaySummary[] }>(response))
      .then((payload) => {
        const loaded = payload.days;
        const wanted = new URLSearchParams(window.location.search).get("date") ?? readCookie(DAY_COOKIE);
        const chosen = loaded.some((item) => item.date === wanted) ? wanted! : (loaded[0]?.date ?? "");
        setDays(loaded);
        setDayState(chosen);
        if (chosen) writeCookie(DAY_COOKIE, chosen);
      })
      .catch((reason) => {
        setDays([]);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
  }, []);

  const setDay = useCallback((next: string) => {
    setDayState(next);
    writeCookie(DAY_COOKIE, next);
  }, []);

  const selectCity = useCallback(async (dir: string) => {
    try {
      await json(await fetch("/api/cities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dir }),
      }));
    } catch (reason) {
      return reason instanceof Error ? reason.message : String(reason);
    }
    // The URL's date belongs to the old build.
    const url = new URL(window.location.href);
    url.searchParams.delete("date");
    window.location.replace(url);
    return null;
  }, []);

  const value = useMemo<Scope>(() => ({
    cities,
    city: cities?.find((item) => item.dir === current) ?? null,
    days, day, error, setDay, selectCity,
  }), [cities, current, days, day, error, setDay, selectCity]);

  return (
    <ScopeContext.Provider value={value}>
      <Suspense fallback={null}>
        <FollowUrl />
      </Suspense>
      {children}
    </ScopeContext.Provider>
  );
}

/**
 * A `?date=` arriving by navigation moves the header to it.
 *
 * Only a change in the URL counts. A page writes the header's day back into
 * its URL a moment after the header changes, and reacting to the stale URL in
 * between would undo the choice that was just made.
 */
function FollowUrl() {
  const date = useSearchParams().get("date");
  const { days, setDay } = useContext(ScopeContext)!;
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!days || date === seen.current) return;
    seen.current = date;
    if (date && days.some((item) => item.date === date)) setDay(date);
  }, [date, days, setDay]);
  return null;
}

export function useScope(): Scope {
  const scope = useContext(ScopeContext);
  if (!scope) throw new Error("useScope outside ScopeProvider");
  return scope;
}

/** The header's day and the build's days. */
export function useDay(): { day: string; days: DaySummary[] | null; error: string | null } {
  const { day, days, error } = useScope();
  return { day, days, error };
}
