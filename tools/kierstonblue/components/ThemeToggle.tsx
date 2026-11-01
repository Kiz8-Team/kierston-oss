"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light";

const STORAGE_KEY = "kierstonblue-theme";

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light");

  useEffect(() => {
    let saved: string | null = null;
    try { saved = window.localStorage.getItem(STORAGE_KEY); } catch { /* private window */ }
    const next: Theme = saved === "dark" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
  }, []);

  function toggle() {
    const next: Theme = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    try { window.localStorage.setItem(STORAGE_KEY, next); } catch { /* as above */ }
  }

  return (
    <button
      type="button"
      className="hud-cell cursor-pointer border-0 bg-transparent text-inherit hover:text-foreground"
      onClick={toggle}
      aria-label={`${theme === "light" ? "Dark" : "Light"} theme`}
      title={`${theme === "light" ? "Dark" : "Light"} theme`}
    >
      {theme === "light" ? "☾" : "☼"}<span className="ml-1">{theme}</span>
    </button>
  );
}
