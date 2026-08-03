import React from "react";
import { createRoot } from "react-dom/client";
import { HashRouter, Route, Routes } from "react-router-dom";
import App from "./App";
import BuildingPage from "./routes/BuildingPage";
import Dashboard from "./routes/Dashboard";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<Dashboard />} />
          <Route path="b/:id" element={<BuildingPage />} />
        </Route>
      </Routes>
    </HashRouter>
  </React.StrictMode>,
);
