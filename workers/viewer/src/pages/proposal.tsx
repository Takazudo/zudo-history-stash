import { Button, Notice, ProposalReview } from "@takazudo/zudo-history-stash-ui";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import {
  hasProposalCreatedFlash,
  PROPOSAL_CREATED_FLASH_MESSAGE,
  stateWithoutProposalFlash,
} from "../app/proposal-routes.js";
import { ErrorBanner } from "../components/error-banner.js";

export default function ProposalPage() {
  const { stash, id } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const incomingCreatedFlash = hasProposalCreatedFlash(location.state);
  const consumedLocationRef = useRef<string | null>(null);
  const [showCreatedFlash, setShowCreatedFlash] = useState(incomingCreatedFlash);

  useEffect(() => {
    if (incomingCreatedFlash) {
      setShowCreatedFlash(true);
      if (consumedLocationRef.current === location.key) return;
      consumedLocationRef.current = location.key;
      navigate(
        {
          pathname: location.pathname,
          search: location.search,
          hash: location.hash,
        },
        { replace: true, state: stateWithoutProposalFlash(location.state) },
      );
      return;
    }

    // Keep the confirmation across the state-consuming replace, then clear it on later navigation.
    if (consumedLocationRef.current !== null) {
      consumedLocationRef.current = null;
      return;
    }
    setShowCreatedFlash(false);
  }, [
    incomingCreatedFlash,
    location.hash,
    location.key,
    location.pathname,
    location.search,
    location.state,
    navigate,
  ]);

  return (
    <div className="proposal-review-route">
      {showCreatedFlash ? (
        <Notice aria-label="Proposal creation confirmation" aria-live="polite" variant="success">
          <span>{PROPOSAL_CREATED_FLASH_MESSAGE}</span>
          <Button size="sm" onClick={() => setShowCreatedFlash(false)}>
            Dismiss
          </Button>
        </Notice>
      ) : null}
      {!stash || !id ? (
        <ErrorBanner error={new Error("The stash name or proposal id is missing from this URL.")} />
      ) : (
        <ProposalReview proposalId={id} stash={stash} />
      )}
    </div>
  );
}
