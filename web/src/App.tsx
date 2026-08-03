import { Link, Outlet } from "react-router-dom";

export default function App() {
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/">
          <h1>Chicago Apartment Tracker</h1>
        </Link>
        <span className="sub">price history · 3D building views</span>
        <span className="spacer" />
      </header>
      <Outlet />
    </div>
  );
}
