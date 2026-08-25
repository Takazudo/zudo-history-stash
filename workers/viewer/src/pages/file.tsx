import { useParams } from "react-router-dom";
import { Page } from "../app/shell/page.js";

export default function FilePage() {
  const { "*": path } = useParams();
  return (
    <Page title={path ?? "File"} description="File content and append-only version history.">
      <section className="placeholder-card">
        <strong>File detail placeholder</strong>
        <p>The body, version history, and comparison controls are composed here by file detail.</p>
      </section>
    </Page>
  );
}
