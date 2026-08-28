import { useParams } from "react-router-dom";
import { ErrorBanner, TokensPanel } from "@takazudo/zudo-history-stash-ui";
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
