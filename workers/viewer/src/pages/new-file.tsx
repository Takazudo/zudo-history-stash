import { useNavigate, useParams } from "react-router-dom";
import { ErrorBanner } from "../../../../packages/ui/src/components/error-banner.js";
import {
  NewFileForm,
  type NewFileCreated,
} from "../../../../packages/ui/src/components/new-file-form.js";
import { useStashHref } from "../../../../packages/ui/src/provider/hooks.js";
import { Page } from "../app/shell/page.js";

export default function NewFilePage() {
  const { stash } = useParams();
  const navigate = useNavigate();
  const hrefFor = useStashHref();

  function handleCreated(created: NewFileCreated) {
    if (!stash) return;
    navigate(hrefFor({ kind: "file", stash, path: created.path }));
  }

  return (
    <Page title="New file" description={stash ? `Create a file in ${stash}.` : "Create a file."}>
      {stash ? (
        <NewFileForm stash={stash} onCreated={handleCreated} />
      ) : (
        <ErrorBanner error={new Error("The stash name is missing from this URL.")} />
      )}
    </Page>
  );
}
