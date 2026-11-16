import React, { lazy } from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes, useParams } from "react-router-dom";
import App from "./App";
import Dashboard from "./routes/Dashboard";
import "./styles.css";

// The building page brings the 3D and chart libraries with it; the dashboard
// must not wait for (or depend on) either.
const BuildingPage = lazy(() => import("./routes/BuildingPage"));

/** One page instance per building: nothing of one building can show under another's name. */
function BuildingRoute() {
  const { id } = useParams<{ id: string }>();
  return <BuildingPage key={id} />;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<Dashboard />} />
          <Route path="b/:id" element={<BuildingRoute />} />
        </Route>
      </Routes>
    </HashRouter>
  </React.StrictMode>,
);
