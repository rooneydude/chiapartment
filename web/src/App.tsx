import { Suspense, useEffect, useState } from "react";
import { Link, Outlet, useLocation, useNavigationType } from "react-router-dom";
import ErrorBoundary from "./components/ErrorBoundary";
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

  // A page opened by a link starts at its top; Back and Forward are left to
  // the browser, which puts the reader where they were.
  const location = useLocation();
  const navigation = useNavigationType();
  useEffect(() => {
    if (navigation !== "POP") window.scrollTo(0, 0);
  }, [location.pathname, navigation]);

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
      <ErrorBoundary
        resetKey={location.pathname}
        fallback={(error) => (
          <div className="error-box" role="alert">
            <strong>This page could not be shown.</strong> {error.message || "Unknown error."}
            <div className="error-actions">
              <button className="retry-btn" onClick={() => window.location.reload()}>
                Reload
              </button>
              <Link to="/">← all buildings</Link>
            </div>
          </div>
        )}
      >
        <Suspense fallback={<div className="skeleton" style={{ height: 320 }} />}>
          <Outlet />
        </Suspense>
      </ErrorBoundary>
    </div>
  );
}
