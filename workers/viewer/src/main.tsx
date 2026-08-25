import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ViewerApp } from "./app/router.js";
import "./styles/tokens.css";
import "./styles/app.css";

const root = document.querySelector("#root");
if (!root) throw new Error("Viewer root element is missing");

createRoot(root).render(
  <StrictMode>
    <ViewerApp />
  </StrictMode>,
);
