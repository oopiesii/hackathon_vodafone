import { useEffect, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "ufv-theme";

const stored = (): Theme | null => {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
};
const system = (): Theme => (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");

// Викликається до першого рендера; без збереженого вибору діє системна тема.
export function applyStoredTheme() {
  const theme = stored();
  if (theme) document.documentElement.dataset.theme = theme;
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? system());
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const listener = () => { if (!stored()) setTheme(system()); };
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, []);
  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* приватний режим: тема діє до перезавантаження */ }
    setTheme(next);
  }
  return { theme, toggle };
}
