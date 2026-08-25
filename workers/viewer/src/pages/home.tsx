import { Page } from "../app/shell/page.js";

export default function HomePage() {
  return (
    <Page title="Stashes" description="Browse every stash available to this principal.">
      <section className="placeholder-card">
        <strong>Stash list placeholder</strong>
        <p>The stash list and recent changes feed are composed here by the stash-list feature.</p>
      </section>
    </Page>
  );
}
