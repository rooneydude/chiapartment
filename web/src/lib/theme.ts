export type ThemePref = "auto" | "light" | "dark";

const KEY = "chiapartment-theme";

export function getThemePref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "auto";
}

export function applyTheme(pref: ThemePref): void {
  if (pref === "auto") {
    localStorage.removeItem(KEY);
    delete document.documentElement.dataset["theme"];
  } else {
    localStorage.setItem(KEY, pref);
    document.documentElement.dataset["theme"] = pref;
  }
  window.dispatchEvent(new CustomEvent("themechange"));
}

export function nextThemePref(pref: ThemePref): ThemePref {
  return pref === "auto" ? "light" : pref === "light" ? "dark" : "auto";
}

/** The effective mode right now, honoring the toggle over the OS setting. */
export function isDarkActive(): boolean {
  const t = document.documentElement.dataset["theme"];
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
