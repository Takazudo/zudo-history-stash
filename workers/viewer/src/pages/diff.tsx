import { useParams } from "react-router-dom";
import { Page } from "../app/shell/page.js";

export default function DiffPage() {
  const { "*": path } = useParams();
  return (
    <Page title={`Diff: ${path ?? "file"}`} description="Compare two immutable file versions.">
      <section className="placeholder-card">
        <strong>Unified diff placeholder</strong>
        <p>
          The hand-rendered diff table and comparison states are composed here by the diff feature.
        </p>
      </section>
    </Page>
  );
}
