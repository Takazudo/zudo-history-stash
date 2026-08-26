import "./styles/tokens.css";
import "@takazudo/zudo-history-stash-ui/styles.css";
import "./components/list-pages.css";
import "./components/history-list.css";
import "./components/diff-table.css";
import "./styles/app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ViewerApp } from "./app/router.js";

const root = document.querySelector("#root");
if (!root) throw new Error("Viewer root element is missing");

createRoot(root).render(
  <StrictMode>
    <ViewerApp />
  </StrictMode>,
);
