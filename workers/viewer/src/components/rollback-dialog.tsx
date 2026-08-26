import type { VersionRecord } from "@takazudo/zudo-history-stash";
import { useCallback } from "react";
import {
  RollbackDialog as RelocatedRollbackDialog,
  type RollbackSuccess,
} from "../../../../packages/ui/src/components/relocated.js";
import { StashUiProvider } from "../../../../packages/ui/src/provider/stash-ui-provider.js";
import type { ViewerStashClient } from "../app/auth/stash-client-provider.js";
import { ViewerAnchor } from "./relocated-link-bridge.js";
import "../../../../packages/ui/src/styles/primitives.css";
import "../../../../packages/ui/src/styles/relocated.css";
import "../../../../packages/ui/src/styles/stateful.css";

export type { RollbackSuccess } from "../../../../packages/ui/src/components/relocated.js";

export interface RollbackDialogProps {
  client: ViewerStashClient;
  stash: string;
  path: string;
  target: VersionRecord;
  onClose: () => void;
  onSuccess: (success: RollbackSuccess) => void;
}

/** Adapt the old client prop until #99 mounts StashUiProvider around the Viewer. */
export function RollbackDialog({ client, ...props }: RollbackDialogProps) {
  const clientForSignal = useCallback((signal: AbortSignal) => client.withSignal(signal), [client]);
  return (
    <StashUiProvider Anchor={ViewerAnchor} client={client} clientForSignal={clientForSignal}>
      <RelocatedRollbackDialog {...props} />
    </StashUiProvider>
  );
}
