import type { StashClient } from "@takazudo/zudo-history-stash";
import { clearWorkbenchDraftsForCredentialChange } from "@takazudo/zudo-history-stash-ui";

export type CredentialChangeResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "validation-failed"
        | "draft-cleanup-failed"
        | "persistence-failed"
        | "site-data-clear-required";
    };

export interface CredentialBoundaryHost<Candidate> {
  validate(candidate: Candidate): Promise<StashClient | null>;
  persist(candidate: Candidate): boolean;
  install(client: StashClient): void;
  removePersisted(): boolean;
  deactivate(): void;
}

export interface LogoutResult {
  draftsCleared: boolean;
  persistedCredentialRemoved: boolean;
  runtimeDeactivated: boolean;
  safeToAuthenticate: boolean;
}

function confirmed(operation: () => boolean): boolean {
  try {
    return operation();
  } catch {
    return false;
  }
}

export function createCredentialBoundary<Candidate>(host: CredentialBoundaryHost<Candidate>) {
  let siteDataClearRequired = false;

  return {
    async replace(candidate: Candidate): Promise<CredentialChangeResult> {
      if (siteDataClearRequired) {
        return { ok: false, reason: "site-data-clear-required" };
      }

      let client: StashClient | null;
      try {
        client = await host.validate(candidate);
      } catch {
        return { ok: false, reason: "validation-failed" };
      }
      if (client === null) return { ok: false, reason: "validation-failed" };

      if (!confirmed(clearWorkbenchDraftsForCredentialChange)) {
        siteDataClearRequired = true;
        return { ok: false, reason: "draft-cleanup-failed" };
      }
      if (!confirmed(() => host.persist(candidate))) {
        siteDataClearRequired = true;
        return { ok: false, reason: "persistence-failed" };
      }

      try {
        host.install(client);
      } catch {
        siteDataClearRequired = true;
        confirmed(() => {
          host.deactivate();
          return true;
        });
        return { ok: false, reason: "site-data-clear-required" };
      }
      return { ok: true };
    },

    logout(): LogoutResult {
      let draftsCleared = false;
      let persistedCredentialRemoved = false;
      let runtimeDeactivated = false;
      try {
        draftsCleared = confirmed(clearWorkbenchDraftsForCredentialChange);
        persistedCredentialRemoved = confirmed(() => host.removePersisted());
      } finally {
        runtimeDeactivated = confirmed(() => {
          host.deactivate();
          return true;
        });
      }

      const safeToAuthenticate = draftsCleared && persistedCredentialRemoved && runtimeDeactivated;
      siteDataClearRequired ||= !safeToAuthenticate;
      return {
        draftsCleared,
        persistedCredentialRemoved,
        runtimeDeactivated,
        safeToAuthenticate,
      };
    },
  };
}
