import { useNavigate, useParams } from "react-router-dom";
import {
  ErrorBanner,
  NewFileForm,
  useStashHref,
  type NewFileCreated,
} from "@takazudo/zudo-history-stash-ui";
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
