"use client";

import { useEffect, useState } from "react";

/**
 * The last few residents you looked at.
 *
 * Reading this data is a back-and-forth — open a docket, follow it to the
 * person, follow the person to their household, then go back to the docket —
 * and the browser's own back button loses the thread as soon as you take a
 * side trip. Keeping the last twelve resident ids means the command palette
 * can offer them by name, so returning to someone is one keystroke rather than
 * a re-search.
 *
 * Ids only: names come from identity.bin, which the palette already has, and
 * writing names here would go stale the moment a generator re-runs.
 */

const KEY = "kb.recent-people";
const LIMIT = 12;

/** Bumped on every write so all mounted readers re-render together. */
const listeners = new Set<() => void>();

function read(): number[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is number => Number.isInteger(entry)).slice(0, LIMIT);
  } catch {
    // A private-mode window or a corrupt entry is not worth failing a page for.
    return [];
  }
}

export function rememberPerson(person: number): void {
  if (typeof window === "undefined" || !Number.isInteger(person) || person < 0) return;
  const next = [person, ...read().filter((entry) => entry !== person)].slice(0, LIMIT);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return;
  }
  for (const notify of listeners) notify();
}

export function clearRecentPeople(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    return;
  }
  for (const notify of listeners) notify();
}

/**
 * The recent list, empty on the server.
 *
 * It starts empty rather than reading localStorage during render: the server
 * has no storage, and a first paint that disagrees with the client is a
 * hydration error. The effect fills it in immediately after.
 */
export function useRecentPeople(): number[] {
  const [people, setPeople] = useState<number[]>([]);

  useEffect(() => {
    const sync = () => setPeople(read());
    sync();
    listeners.add(sync);
    // Another tab writing the same key should show up here too.
    window.addEventListener("storage", sync);
    return () => {
      listeners.delete(sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  return people;
}
