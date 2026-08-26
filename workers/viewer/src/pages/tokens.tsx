import { useParams } from "react-router-dom";
import { ErrorBanner } from "../../../../packages/ui/src/components/error-banner.js";
import { TokensPanel } from "../../../../packages/ui/src/components/tokens-panel.js";
import { Page } from "../app/shell/page.js";

export default function TokensPage() {
  const { stash } = useParams();

  return (
    <Page
      title="Tokens"
      description={stash ? `Manage access to ${stash}.` : "Manage stash access."}
    >
      {stash ? (
        <TokensPanel stash={stash} />
      ) : (
        <ErrorBanner error={new Error("The stash name is missing from this URL.")} />
      )}
    </Page>
  );
}
