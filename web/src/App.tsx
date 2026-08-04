import { useEffect, useState } from "react";
import { Link, Outlet } from "react-router-dom";
import { applyTheme, getThemePref, nextThemePref, type ThemePref } from "./lib/theme";

const THEME_ICON: Record<ThemePref, string> = { auto: "◐", light: "☀", dark: "☾" };
const THEME_LABEL: Record<ThemePref, string> = {
  auto: "theme: match system",
  light: "theme: light",
  dark: "theme: dark",
};

export default function App() {
  const [pref, setPref] = useState<ThemePref>(getThemePref);

  useEffect(() => {
    applyTheme(pref);
  }, [pref]);

  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand">
          <span className="brand-mark">🏙</span>
          <h1>Chicago Apartment Tracker</h1>
        </Link>
        <span className="sub">price history · 3D building views</span>
        <span className="spacer" />
        <button
          className="theme-btn"
          title={THEME_LABEL[pref]}
          onClick={() => setPref(nextThemePref(pref))}
        >
          {THEME_ICON[pref]}
        </button>
      </header>
      <Outlet />
    </div>
  );
}
