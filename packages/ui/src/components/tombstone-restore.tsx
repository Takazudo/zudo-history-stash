import type { FileRecord, StashClient, VersionRecord } from "@takazudo/zudo-history-stash";
import { useState } from "react";
import { useCanWrite, useStashClient } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { RollbackDialog, type RollbackSuccess } from "./rollback-dialog.js";

const clientIdentityKeys = new WeakMap<object, number>();
let nextClientIdentityKey = 1;

export interface TombstoneRestoreProps {
  stash: string;
  path: string;
  head: Pick<FileRecord, "version" | "deleted">;
  versions: readonly VersionRecord[];
  onChanged: (success: RollbackSuccess) => void;
}

function keyForClient(client: StashClient): number {
  const existing = clientIdentityKeys.get(client);
  if (existing !== undefined) return existing;
  const key = nextClientIdentityKey;
  nextClientIdentityKey += 1;
  clientIdentityKeys.set(client, key);
  return key;
}

function lastLiveVersion(
  headVersion: number,
  versions: readonly VersionRecord[],
): VersionRecord | null {
  let latest: VersionRecord | null = null;
  for (const version of versions) {
    if (
      version.version < headVersion &&
      version.kind !== "delete" &&
      (latest === null || version.version > latest.version)
    ) {
      latest = version;
    }
  }
  return latest;
}

interface TombstoneRestoreAvailableProps extends TombstoneRestoreProps {
  target: VersionRecord;
}

function TombstoneRestoreAvailable({
  stash,
  path,
  target,
  onChanged,
}: TombstoneRestoreAvailableProps) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="zhs-tombstone-restore">
      <Button onClick={() => setDialogOpen(true)}>Restore v{target.version}…</Button>
      {dialogOpen ? (
        <RollbackDialog
          path={path}
          stash={stash}
          target={target}
          onClose={() => setDialogOpen(false)}
          onSuccess={(success) => {
            setDialogOpen(false);
            onChanged(success);
          }}
        />
      ) : null}
    </div>
  );
}

export function TombstoneRestore(props: TombstoneRestoreProps) {
  const client = useStashClient();
  const capability = useCanWrite(props.stash);
  const target = lastLiveVersion(props.head.version, props.versions);
  if (!capability.ready || !capability.canWrite || !props.head.deleted || target === null) {
    return null;
  }
  const targetKey = JSON.stringify([
    keyForClient(client),
    props.stash,
    props.path,
    props.head.version,
    target.version,
    target.hash,
    target.kind,
  ]);
  return <TombstoneRestoreAvailable key={targetKey} {...props} target={target} />;
}
