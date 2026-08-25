import { useParams } from "react-router-dom";
import { Page } from "../app/shell/page.js";

export default function StashPage() {
  const { stash } = useParams();
  return (
    <Page title={stash ?? "Stash"} description="Files and recent changes in this stash.">
      <section className="placeholder-card">
        <strong>File list placeholder</strong>
        <p>The file list and stash changes rail are composed here by the file-list feature.</p>
      </section>
    </Page>
  );
}
