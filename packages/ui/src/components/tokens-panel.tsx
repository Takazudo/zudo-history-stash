import type { CreateTokenBody, StashClient, TokenRecord } from "@takazudo/zudo-history-stash";
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useIsAdmin, useStashClient, useStashClientForSignal } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../primitives/table.js";
import { ErrorBanner } from "./error-banner.js";
import { MintTokenForm } from "./mint-token-form.js";
import { RelativeTime } from "./relative-time.js";
import { RevokeTokenDialog } from "./revoke-token-dialog.js";

interface TokenTarget {
  client: StashClient;
  stash: string;
}

type TokenListResult =
  | { state: "loading" }
  | { state: "ready"; tokens: TokenRecord[] }
  | { state: "error"; error: unknown };

interface TokenListSnapshot {
  target: TokenTarget;
  result: TokenListResult;
}

interface SecretSnapshot {
  target: TokenTarget;
  token: string;
}

interface RevokeSnapshot {
  target: TokenTarget;
  token: TokenRecord;
}

export interface TokensPanelProps {
  stash: string;
}

function newestFirst(tokens: readonly TokenRecord[]): TokenRecord[] {
  return [...tokens].sort((left, right) => {
    const leftCreatedAt = Date.parse(left.createdAt);
    const rightCreatedAt = Date.parse(right.createdAt);
    const createdOrder =
      Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt)
        ? rightCreatedAt - leftCreatedAt
        : 0;
    if (createdOrder !== 0) return createdOrder;
    return right.id.localeCompare(left.id);
  });
}

function OneTimeSecret({ token, onDismiss }: { token: string; onDismiss: () => void }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");

  async function copyToken() {
    try {
      if (navigator.clipboard === undefined) throw new Error("Clipboard access is unavailable");
      await navigator.clipboard.writeText(token);
      setCopyState("copied");
    } catch {
      setCopyState("error");
    }
  }

  return (
    <Notice className="zhs-tokens-secret" variant="warning">
      <strong>Shown once — store it now</strong>
      <div className="zhs-tokens-secret-value">
        <Input
          aria-label="New token secret"
          className="zhs-tokens-secret-input"
          readOnly
          value={token}
          onFocus={(event) => event.currentTarget.select()}
        />
        <Button size="sm" onClick={() => void copyToken()}>
          Copy
        </Button>
      </div>
      {copyState === "copied" ? <p role="status">Copied to the clipboard.</p> : null}
      {copyState === "error" ? (
        <p role="alert">Copy failed. Select the secret above and copy it manually.</p>
      ) : null}
      <p>
        If this response was lost before you copied it, the secret is unrecoverable: revoke this
        token and mint a new one
      </p>
      <div className="zhs-tokens-secret-actions">
        <Button size="sm" onClick={onDismiss}>
          I stored it
        </Button>
      </div>
    </Notice>
  );
}

function TokenTable({
  stash,
  tokens,
  onRevoke,
}: {
  stash: string;
  tokens: TokenRecord[];
  onRevoke: (token: TokenRecord) => void;
}) {
  return (
    <div className="zhs-tokens-table-scroll">
      <Table className="zhs-tokens-table">
        <TableCaption>Tokens for {stash}</TableCaption>
        <TableHead>
          <TableRow>
            <TableHeader scope="col">ID</TableHeader>
            <TableHeader scope="col">Label</TableHeader>
            <TableHeader scope="col">Scope</TableHeader>
            <TableHeader scope="col">Created</TableHeader>
            <TableHeader scope="col">Last used</TableHeader>
            <TableHeader scope="col">Revoked</TableHeader>
            <TableHeader scope="col">Actions</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {tokens.map((token) => (
            <TableRow key={token.id} data-token-id={token.id}>
              <TableCell className="zhs-tokens-table__id">
                <code>{token.id}</code>
              </TableCell>
              <TableCell className="zhs-tokens-table__label">{token.label || "—"}</TableCell>
              <TableCell className="zhs-tokens-table__compact">
                <span className={`zhs-tokens-scope zhs-tokens-scope--${token.scope}`}>
                  {token.scope}
                </span>
              </TableCell>
              <TableCell className="zhs-tokens-table__compact">
                <RelativeTime value={token.createdAt} />
              </TableCell>
              <TableCell className="zhs-tokens-table__compact">
                {token.lastUsedAt ? <RelativeTime value={token.lastUsedAt} /> : "Never"}
              </TableCell>
              <TableCell className="zhs-tokens-table__compact">
                {token.revokedAt ? <RelativeTime value={token.revokedAt} /> : "Active"}
              </TableCell>
              <TableCell className="zhs-tokens-table__actions">
                {token.revokedAt ? (
                  <span className="zhs-tokens-revoked-label">Revoked</span>
                ) : (
                  <Button
                    aria-label={`Revoke ${token.label || token.id}`}
                    size="sm"
                    variant="danger"
                    onClick={() => onRevoke(token)}
                  >
                    Revoke
                  </Button>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function TokensPanel({ stash }: TokensPanelProps) {
  const panelTitleId = useId();
  const listTitleId = useId();
  const client = useStashClient();
  const clientForSignal = useStashClientForSignal();
  const admin = useIsAdmin();
  const target = useMemo<TokenTarget>(() => ({ client, stash }), [client, stash]);
  const activeTargetRef = useRef(target);
  const requestSequenceRef = useRef(0);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [listSnapshot, setListSnapshot] = useState<TokenListSnapshot | null>(null);
  const [secretSnapshot, setSecretSnapshot] = useState<SecretSnapshot | null>(null);
  const [revokeSnapshot, setRevokeSnapshot] = useState<RevokeSnapshot | null>(null);

  useLayoutEffect(() => {
    activeTargetRef.current = target;
  }, [target]);

  useEffect(() => {
    const sequence = ++requestSequenceRef.current;
    if (!admin.ready || !admin.isAdmin) return;

    const controller = new AbortController();
    setListSnapshot({ target, result: { state: "loading" } });
    void Promise.resolve()
      .then(() => clientForSignal(controller.signal).stashes.tokens(stash).list())
      .then(
        (result) => {
          if (controller.signal.aborted || requestSequenceRef.current !== sequence) return;
          setListSnapshot({
            target,
            result: result.ok
              ? { state: "ready", tokens: newestFirst(result.value.tokens) }
              : { state: "error", error: result },
          });
        },
        (error: unknown) => {
          if (controller.signal.aborted || requestSequenceRef.current !== sequence) return;
          setListSnapshot({ target, result: { state: "error", error } });
        },
      );

    return () => controller.abort();
  }, [admin.isAdmin, admin.ready, clientForSignal, reloadVersion, stash, target]);

  const refresh = useCallback(() => {
    setReloadVersion((version) => version + 1);
  }, []);

  const handleMint = useCallback(
    async (input: CreateTokenBody) => {
      const result = await target.client.stashes.tokens(target.stash).create(input);
      if (!result.ok) throw result;
      if (activeTargetRef.current !== target) return;

      setSecretSnapshot({ target, token: result.value.token });
      refresh();
    },
    [refresh, target],
  );

  const visibleSecret = secretSnapshot?.target === target ? secretSnapshot.token : null;
  const visibleRevoke = revokeSnapshot?.target === target ? revokeSnapshot.token : null;
  const listResult =
    listSnapshot?.target === target
      ? listSnapshot.result
      : ({ state: "loading" } satisfies TokenListResult);

  async function handleRevoke() {
    if (visibleRevoke === null) return;
    const result = await target.client.stashes.tokens(target.stash).revoke(visibleRevoke.id);
    if (!result.ok) throw result;
    if (activeTargetRef.current !== target) return;

    setRevokeSnapshot(null);
    refresh();
  }

  if (!admin.ready) {
    return (
      <section className="zhs-tokens-not-available" role="status">
        <h2>Checking administrator access…</h2>
      </section>
    );
  }

  if (!admin.isAdmin) {
    return (
      <section className="zhs-tokens-not-available" role="status">
        <h2>Token administration is not available</h2>
        <p>An administrator token is required to manage stash tokens.</p>
      </section>
    );
  }

  return (
    <section className="zhs-tokens-panel" aria-labelledby={panelTitleId}>
      <header className="zhs-tokens-panel__header">
        <div>
          <h2 id={panelTitleId}>Access tokens</h2>
          <p>Manage scoped credentials for {stash}.</p>
        </div>
      </header>

      <MintTokenForm onMint={handleMint} />

      {visibleSecret ? (
        <OneTimeSecret
          key={visibleSecret}
          token={visibleSecret}
          onDismiss={() => setSecretSnapshot(null)}
        />
      ) : null}

      <section className="zhs-tokens-list" aria-labelledby={listTitleId}>
        <div className="zhs-tokens-section-heading">
          <div>
            <h3 id={listTitleId}>Issued tokens</h3>
            <p>Secrets are never returned by this list.</p>
          </div>
        </div>
        {listResult.state === "loading" ? (
          <p className="zhs-tokens-loading" role="status">
            Loading tokens…
          </p>
        ) : null}
        {listResult.state === "error" ? (
          <div className="zhs-tokens-list-error">
            <ErrorBanner error={listResult.error} onRetry={refresh} title="Could not load tokens" />
          </div>
        ) : null}
        {listResult.state === "ready" && listResult.tokens.length === 0 ? (
          <p className="zhs-tokens-empty">No tokens have been minted for this stash.</p>
        ) : null}
        {listResult.state === "ready" && listResult.tokens.length > 0 ? (
          <TokenTable
            stash={stash}
            tokens={listResult.tokens}
            onRevoke={(token) => setRevokeSnapshot({ target, token })}
          />
        ) : null}
      </section>

      {visibleRevoke ? (
        <RevokeTokenDialog
          key={visibleRevoke.id}
          open={true}
          token={visibleRevoke}
          onClose={() => setRevokeSnapshot(null)}
          onConfirm={handleRevoke}
        />
      ) : null}
    </section>
  );
}
