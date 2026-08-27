import type {
  CreateTokenBody,
  RotateTokenBody,
  RotateTokenResult,
  StashClient,
  TokenRecord,
} from "@takazudo/zudo-history-stash";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { useIsAdmin, useStashClient, useStashClientForSignal } from "../provider/hooks.js";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import { Select } from "../primitives/select.js";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../primitives/table.js";
import { ErrorBanner, stashErrorDetails } from "./error-banner.js";
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
  originStash: string;
  token: string;
  kind: "mint" | "rotation";
  successorId?: string;
}

interface MintAttempt {
  target: TokenTarget;
  generation: number;
}

interface RevokeSnapshot {
  target: TokenTarget;
  token: TokenRecord;
}

interface RevokeAttempt {
  completion?: Promise<void>;
  operation: RevokeSnapshot;
}

interface RevokeErrorSnapshot {
  error: unknown;
  operation: RevokeSnapshot;
}

interface RotateSnapshot {
  target: TokenTarget;
  token: TokenRecord;
}

interface RotateAttempt {
  completion?: Promise<void>;
  operation: RotateSnapshot;
}

interface RotateErrorSnapshot {
  error: unknown;
  operation: RotateSnapshot;
}

type SecretProducer =
  { kind: "mint"; attempt: MintAttempt } | { kind: "rotation"; operation: RotateSnapshot };

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

function isSameTokenTarget(left: TokenTarget, right: TokenTarget): boolean {
  return left.client === right.client && left.stash === right.stash;
}

function isSameRevokeSubject(left: RevokeSnapshot, right: RevokeSnapshot): boolean {
  return isSameTokenTarget(left.target, right.target) && left.token.id === right.token.id;
}

function isSameRotateSubject(left: RotateSnapshot, right: RotateSnapshot): boolean {
  return isSameTokenTarget(left.target, right.target) && left.token.id === right.token.id;
}

function OneTimeSecret({
  kind,
  originStash,
  successorId,
  token,
  onDismiss,
}: {
  kind: SecretSnapshot["kind"];
  originStash: string;
  successorId?: string;
  token: string;
  onDismiss: () => void;
}) {
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
    <Notice className="zhs-tokens-secret" role="status" variant="warning">
      <strong>Shown once — store it now</strong>
      <p>
        Origin stash: <code>{originStash}</code>
      </p>
      {successorId ? (
        <p>
          Successor ID: <code>{successorId}</code>
        </p>
      ) : null}
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
      {kind === "rotation" ? (
        <p>
          If you lose this secret, revoke the successor and mint a new token — a rotated token
          cannot be rotated again
        </p>
      ) : (
        <p>
          If this response was lost before you copied it, the secret is unrecoverable: revoke this
          token and mint a new one
        </p>
      )}
      <div className="zhs-tokens-secret-actions">
        <Button size="sm" onClick={onDismiss}>
          I stored it
        </Button>
      </div>
    </Notice>
  );
}

function TokenExpiry({ expiresAt, now }: { expiresAt: string | null; now: number }) {
  if (expiresAt === null) return <>Never</>;
  const timestamp = Date.parse(expiresAt);
  if (Number.isFinite(timestamp) && timestamp <= now) {
    return (
      <span className="zhs-tokens-expired" title={new Date(timestamp).toLocaleString()}>
        Expired
      </span>
    );
  }
  return <RelativeTime now={now} value={expiresAt} />;
}

type RotateExpiry = "inherit" | "day" | "month" | "year" | "custom";

interface RotateDraft {
  operationKey: object;
  graceSeconds: number;
  expiry: RotateExpiry;
  customExpiresAt: string;
}

interface RotateOperation {
  operationKey: object;
  generation: number;
}

type RotateOperationSnapshot =
  | { operation: RotateOperation; state: "submitting" }
  | { operation: RotateOperation; state: "error"; error: unknown };

const ROTATE_TTL_SECONDS: Record<Exclude<RotateExpiry, "inherit" | "custom">, number> = {
  day: 86_400,
  month: 2_592_000,
  year: 31_536_000,
};

function initialRotateDraft(operationKey: object): RotateDraft {
  return { operationKey, graceSeconds: 300, expiry: "inherit", customExpiresAt: "" };
}

function rotateInput(draft: Omit<RotateDraft, "operationKey">): RotateTokenBody {
  const expiry =
    draft.expiry === "inherit"
      ? {}
      : draft.expiry === "custom"
        ? { expiresAt: draft.customExpiresAt.trim() }
        : { ttlSeconds: ROTATE_TTL_SECONDS[draft.expiry] };
  return { graceSeconds: draft.graceSeconds, ...expiry };
}

function RotateTokenDialog({
  error: controlledError,
  open,
  operationKey,
  pending = false,
  token,
  onClose,
  onConfirm,
}: {
  error?: unknown;
  open: boolean;
  operationKey: object;
  pending?: boolean;
  token: TokenRecord;
  onClose: () => void;
  onConfirm: (input: RotateTokenBody) => Promise<void>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const activeOperationKeyRef = useRef(operationKey);
  const operationGenerationRef = useRef(0);
  const activeOperationRef = useRef<RotateOperation | null>(null);
  const [draft, setDraft] = useState<RotateDraft>(() => initialRotateDraft(operationKey));
  const [operationSnapshot, setOperationSnapshot] = useState<RotateOperationSnapshot | null>(null);
  const graceSeconds = draft.operationKey === operationKey ? draft.graceSeconds : 300;
  const expiry = draft.operationKey === operationKey ? draft.expiry : "inherit";
  const customExpiresAt = draft.operationKey === operationKey ? draft.customExpiresAt : "";
  const localSubmitting =
    operationSnapshot?.operation.operationKey === operationKey &&
    operationSnapshot.state === "submitting";
  const localError =
    operationSnapshot?.operation.operationKey === operationKey &&
    operationSnapshot.state === "error"
      ? operationSnapshot.error
      : null;
  const submitting = pending || localSubmitting;
  const error = controlledError ?? localError;
  const errorDetails = error === null || error === undefined ? null : stashErrorDetails(error);

  useLayoutEffect(() => {
    if (activeOperationKeyRef.current === operationKey) return;
    activeOperationKeyRef.current = operationKey;
    if (activeOperationRef.current?.operationKey !== operationKey) {
      activeOperationRef.current = null;
    }
  }, [operationKey]);

  function updateDraft(update: Partial<Omit<RotateDraft, "operationKey">>) {
    setDraft((current) => ({
      ...(current.operationKey === operationKey ? current : initialRotateDraft(operationKey)),
      ...update,
      operationKey,
    }));
  }

  function isCurrentOperation(operation: RotateOperation): boolean {
    return (
      activeOperationKeyRef.current === operation.operationKey &&
      activeOperationRef.current?.operationKey === operation.operationKey &&
      activeOperationRef.current.generation === operation.generation
    );
  }

  function handleClose() {
    if (pending || activeOperationRef.current?.operationKey === operationKey) return;
    onClose();
  }

  async function handleConfirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || activeOperationRef.current?.operationKey === operationKey) return;

    const operation: RotateOperation = {
      operationKey,
      generation: ++operationGenerationRef.current,
    };
    activeOperationRef.current = operation;
    setOperationSnapshot({ operation, state: "submitting" });
    try {
      await onConfirm(
        rotateInput({
          graceSeconds,
          expiry,
          customExpiresAt,
        }),
      );
      if (isCurrentOperation(operation)) setOperationSnapshot(null);
    } catch (requestError) {
      if (isCurrentOperation(operation)) {
        setOperationSnapshot({ operation, state: "error", error: requestError });
      }
    } finally {
      if (isCurrentOperation(operation)) {
        activeOperationRef.current = null;
        setOperationSnapshot((current) =>
          current?.operation.generation === operation.generation && current.state === "submitting"
            ? null
            : current,
        );
      }
    }
  }

  return (
    <Dialog
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      className="zhs-tokens-rotate-dialog"
      open={open}
      onClose={handleClose}
    >
      <form
        aria-busy={submitting ? "true" : undefined}
        className="zhs-tokens-rotate-dialog__form"
        onSubmit={(event) => void handleConfirm(event)}
      >
        <header className="zhs-tokens-dialog-header">
          <div>
            <p className="zhs-tokens-dialog-eyebrow">Access token</p>
            <h2 id={titleId}>Rotate token</h2>
          </div>
          <Button
            aria-label="Close rotate token dialog"
            disabled={submitting}
            size="sm"
            onClick={handleClose}
          >
            Close
          </Button>
        </header>
        <div className="zhs-tokens-dialog-body zhs-tokens-rotate-dialog__body">
          <p id={descriptionId}>
            Mint a successor for <code>{token.label || token.id}</code>. The current token remains
            valid only for the selected grace period.
          </p>
          <label className="zhs-tokens-field">
            <span className="zhs-tokens-field__label">Grace period</span>
            <Select
              disabled={submitting}
              name="graceSeconds"
              value={String(graceSeconds)}
              onChange={(event) => updateDraft({ graceSeconds: Number(event.currentTarget.value) })}
            >
              <option value="0">None — expire immediately</option>
              <option value="300">5 minutes</option>
              <option value="3600">1 hour</option>
              <option value="86400">24 hours</option>
            </Select>
          </label>
          <label className="zhs-tokens-field">
            <span className="zhs-tokens-field__label">Successor expiry</span>
            <Select
              disabled={submitting}
              name="successorExpiry"
              value={expiry}
              onChange={(event) =>
                updateDraft({ expiry: event.currentTarget.value as RotateExpiry })
              }
            >
              <option value="inherit">Inherit predecessor expiry</option>
              <option value="day">1 day</option>
              <option value="month">30 days</option>
              <option value="year">1 year</option>
              <option value="custom">Custom ISO</option>
            </Select>
          </label>
          {expiry === "custom" ? (
            <label className="zhs-tokens-field">
              <span className="zhs-tokens-field__label">Custom successor expiry (ISO 8601)</span>
              <Input
                autoComplete="off"
                disabled={submitting}
                name="expiresAt"
                placeholder="2027-08-26T09:00:00.000Z"
                required
                value={customExpiresAt}
                onChange={(event) => updateDraft({ customExpiresAt: event.currentTarget.value })}
              />
            </label>
          ) : null}
          {error ? <ErrorBanner error={error} title="Could not rotate the token" /> : null}
          {errorDetails?.code === "already-rotated" ? (
            <Notice className="zhs-tokens-rotation-recovery" variant="warning">
              <strong>This token was already rotated.</strong>
              {errorDetails.successorId ? (
                <p>
                  Successor ID: <code>{errorDetails.successorId}</code>
                </p>
              ) : (
                <p>The successor ID was not returned.</p>
              )}
              <p>Revoke the successor and mint a new token if its one-time secret was lost.</p>
            </Notice>
          ) : null}
        </div>
        <footer className="zhs-tokens-dialog-footer">
          <Button disabled={submitting} onClick={handleClose}>
            Cancel
          </Button>
          <Button disabled={submitting} type="submit" variant="primary">
            {submitting ? "Rotating…" : "Confirm rotation"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}

function TokenTable({
  rotateDisabled,
  stash,
  tokens,
  onRotate,
  onRevoke,
}: {
  rotateDisabled: boolean;
  stash: string;
  tokens: TokenRecord[];
  onRotate: (token: TokenRecord) => void;
  onRevoke: (token: TokenRecord) => void;
}) {
  const now = Date.now();
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
            <TableHeader scope="col">Expires</TableHeader>
            <TableHeader scope="col">Rotated from</TableHeader>
            <TableHeader scope="col">Rotated to</TableHeader>
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
                <RelativeTime now={now} value={token.createdAt} />
              </TableCell>
              <TableCell className="zhs-tokens-table__compact zhs-tokens-table__expiry">
                <TokenExpiry expiresAt={token.expiresAt} now={now} />
              </TableCell>
              <TableCell className="zhs-tokens-table__relation">
                {token.rotatedFrom ? <code>{token.rotatedFrom}</code> : "—"}
              </TableCell>
              <TableCell className="zhs-tokens-table__relation">
                {token.rotatedTo ? <code>{token.rotatedTo}</code> : "—"}
              </TableCell>
              <TableCell className="zhs-tokens-table__compact">
                {token.lastUsedAt ? <RelativeTime now={now} value={token.lastUsedAt} /> : "Never"}
              </TableCell>
              <TableCell className="zhs-tokens-table__compact">
                {token.revokedAt ? <RelativeTime now={now} value={token.revokedAt} /> : "Active"}
              </TableCell>
              <TableCell className="zhs-tokens-table__actions">
                {token.revokedAt ? (
                  <span className="zhs-tokens-revoked-label">Revoked</span>
                ) : (
                  <div className="zhs-tokens-table__action-group">
                    {token.rotatedTo === null ? (
                      <Button
                        aria-label={`Rotate ${token.label ? `${token.label} (${token.id})` : token.id}`}
                        disabled={rotateDisabled}
                        size="sm"
                        onClick={() => onRotate(token)}
                      >
                        Rotate…
                      </Button>
                    ) : null}
                    <Button
                      aria-label={`Revoke ${token.label || token.id}`}
                      size="sm"
                      variant="danger"
                      onClick={() => onRevoke(token)}
                    >
                      Revoke
                    </Button>
                  </div>
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
  const mintGenerationRef = useRef(0);
  const activeMintAttemptRef = useRef<MintAttempt | null>(null);
  const secretSnapshotRef = useRef<SecretSnapshot | null>(null);
  const activeSecretProducerRef = useRef<SecretProducer | null>(null);
  const activeRotateAttemptsRef = useRef<RotateAttempt[]>([]);
  const rotateSnapshotRef = useRef<RotateSnapshot | null>(null);
  const activeRevokeAttemptsRef = useRef<RevokeAttempt[]>([]);
  const revokeSnapshotRef = useRef<RevokeSnapshot | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [mintAttempt, setMintAttempt] = useState<MintAttempt | null>(null);
  const [listSnapshot, setListSnapshot] = useState<TokenListSnapshot | null>(null);
  const [secretSnapshot, setSecretSnapshot] = useState<SecretSnapshot | null>(null);
  const [rotateSnapshot, setRotateSnapshot] = useState<RotateSnapshot | null>(null);
  const [rotateAttempts, setRotateAttempts] = useState<RotateAttempt[]>([]);
  const [rotateErrorSnapshot, setRotateErrorSnapshot] = useState<RotateErrorSnapshot | null>(null);
  const [revokeSnapshot, setRevokeSnapshot] = useState<RevokeSnapshot | null>(null);
  const [revokeAttempts, setRevokeAttempts] = useState<RevokeAttempt[]>([]);
  const [revokeErrorSnapshot, setRevokeErrorSnapshot] = useState<RevokeErrorSnapshot | null>(null);

  useLayoutEffect(() => {
    activeTargetRef.current = target;
    const selected = rotateSnapshotRef.current;
    if (
      selected !== null &&
      !isSameTokenTarget(selected.target, target) &&
      !activeRotateAttemptsRef.current.some((attempt) => attempt.operation === selected)
    ) {
      rotateSnapshotRef.current = null;
      if (
        activeSecretProducerRef.current?.kind === "rotation" &&
        activeSecretProducerRef.current.operation === selected
      ) {
        activeSecretProducerRef.current = null;
      }
      setRotateSnapshot((current) => (current === selected ? null : current));
      setRotateErrorSnapshot((current) => (current?.operation === selected ? null : current));
    }
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
      if (
        activeSecretProducerRef.current !== null ||
        activeMintAttemptRef.current !== null ||
        activeRotateAttemptsRef.current.length > 0 ||
        rotateSnapshotRef.current !== null ||
        secretSnapshotRef.current !== null
      ) {
        return;
      }

      const attempt: MintAttempt = {
        target,
        generation: ++mintGenerationRef.current,
      };
      activeSecretProducerRef.current = { kind: "mint", attempt };
      activeMintAttemptRef.current = attempt;
      setMintAttempt(attempt);
      try {
        const result = await attempt.target.client.stashes
          .tokens(attempt.target.stash)
          .create(input);
        if (!result.ok) throw result;

        const secret: SecretSnapshot = {
          kind: "mint",
          originStash: attempt.target.stash,
          token: result.value.token,
        };
        secretSnapshotRef.current = secret;
        setSecretSnapshot(secret);
        if (isSameTokenTarget(activeTargetRef.current, attempt.target)) refresh();
      } finally {
        if (
          activeSecretProducerRef.current?.kind === "mint" &&
          activeSecretProducerRef.current.attempt === attempt
        ) {
          activeSecretProducerRef.current = null;
        }
        if (activeMintAttemptRef.current?.generation === attempt.generation) {
          activeMintAttemptRef.current = null;
          setMintAttempt((current) =>
            current?.generation === attempt.generation ? null : current,
          );
        }
      }
    },
    [refresh, target],
  );

  const visibleSecret = secretSnapshot;
  const visibleRotate =
    rotateSnapshot !== null && isSameTokenTarget(rotateSnapshot.target, target)
      ? rotateSnapshot
      : null;
  const visibleRotateAttempt =
    visibleRotate === null
      ? null
      : (rotateAttempts.find((attempt) => attempt.operation === visibleRotate) ?? null);
  const visibleRotateError =
    visibleRotate !== null && rotateErrorSnapshot?.operation === visibleRotate
      ? rotateErrorSnapshot.error
      : null;
  const visibleRevoke =
    revokeSnapshot !== null && isSameTokenTarget(revokeSnapshot.target, target)
      ? revokeSnapshot
      : null;
  const visibleRevokeAttempt =
    visibleRevoke === null
      ? null
      : (revokeAttempts.find((attempt) => attempt.operation === visibleRevoke) ?? null);
  const visibleRevokeError =
    visibleRevoke !== null && revokeErrorSnapshot?.operation === visibleRevoke
      ? revokeErrorSnapshot.error
      : null;
  const listResult =
    listSnapshot?.target === target
      ? listSnapshot.result
      : ({ state: "loading" } satisfies TokenListResult);

  function selectRevoke(token: TokenRecord) {
    const candidate = { target, token };
    const activeAttempt = activeRevokeAttemptsRef.current.find((attempt) =>
      isSameRevokeSubject(attempt.operation, candidate),
    );
    const operation = activeAttempt?.operation ?? candidate;
    revokeSnapshotRef.current = operation;
    setRevokeSnapshot(operation);
    setRevokeErrorSnapshot((current) => (current?.operation === operation ? current : null));
  }

  function selectRotate(token: TokenRecord) {
    if (
      activeSecretProducerRef.current !== null ||
      activeMintAttemptRef.current !== null ||
      activeRotateAttemptsRef.current.length > 0 ||
      secretSnapshotRef.current !== null
    ) {
      return;
    }
    const candidate = { target, token };
    activeSecretProducerRef.current = { kind: "rotation", operation: candidate };
    rotateSnapshotRef.current = candidate;
    setRotateSnapshot(candidate);
    setRotateErrorSnapshot(null);
  }

  function closeRotate(operation: RotateSnapshot) {
    if (
      activeRotateAttemptsRef.current.some((attempt) => attempt.operation === operation) ||
      rotateSnapshotRef.current !== operation
    ) {
      return;
    }
    rotateSnapshotRef.current = null;
    if (
      activeSecretProducerRef.current?.kind === "rotation" &&
      activeSecretProducerRef.current.operation === operation
    ) {
      activeSecretProducerRef.current = null;
    }
    setRotateSnapshot((current) => (current === operation ? null : current));
    setRotateErrorSnapshot((current) => (current?.operation === operation ? null : current));
  }

  function updateListAfterRotation(operation: RotateSnapshot, result: RotateTokenResult) {
    setListSnapshot((current) => {
      if (current?.target !== operation.target || current.result.state !== "ready") return current;
      const successor: TokenRecord = {
        id: result.id,
        label: result.label,
        scope: result.scope,
        createdAt: result.createdAt,
        expiresAt: result.expiresAt,
        rotatedFrom: result.rotatedFrom,
        rotatedTo: null,
        revokedAt: null,
        lastUsedAt: null,
      };
      const tokens = current.result.tokens
        .filter((token) => token.id !== successor.id)
        .map((token) =>
          token.id === operation.token.id
            ? {
                ...token,
                expiresAt: result.predecessor.expiresAt,
                rotatedTo: result.id,
              }
            : token,
        );
      return {
        target: current.target,
        result: { state: "ready", tokens: newestFirst([successor, ...tokens]) },
      };
    });
  }

  function markAlreadyRotated(operation: RotateSnapshot, successorId: string) {
    setListSnapshot((current) => {
      if (current?.target !== operation.target || current.result.state !== "ready") return current;
      return {
        target: current.target,
        result: {
          state: "ready",
          tokens: current.result.tokens.map((token) =>
            token.id === operation.token.id ? { ...token, rotatedTo: successorId } : token,
          ),
        },
      };
    });
  }

  function handleRotate(operation: RotateSnapshot, input: RotateTokenBody): Promise<void> {
    const existingAttempt = activeRotateAttemptsRef.current.find((attempt) =>
      isSameRotateSubject(attempt.operation, operation),
    );
    if (existingAttempt !== undefined) {
      return existingAttempt.completion ?? Promise.resolve();
    }
    if (
      activeSecretProducerRef.current?.kind !== "rotation" ||
      activeSecretProducerRef.current.operation !== operation ||
      secretSnapshotRef.current !== null
    ) {
      return Promise.resolve();
    }

    const attempt: RotateAttempt = { operation };
    activeRotateAttemptsRef.current = [...activeRotateAttemptsRef.current, attempt];
    setRotateAttempts((current) => [...current, attempt]);
    setRotateErrorSnapshot((current) => (current?.operation === operation ? null : current));

    const completion = (async () => {
      try {
        const result = await operation.target.client.stashes
          .tokens(operation.target.stash)
          .rotate(operation.token.id, input);
        if (!result.ok) throw result;

        const secret: SecretSnapshot = {
          kind: "rotation",
          originStash: operation.target.stash,
          successorId: result.value.id,
          token: result.value.token,
        };
        secretSnapshotRef.current = secret;
        setSecretSnapshot(secret);
        updateListAfterRotation(operation, result.value);
        if (rotateSnapshotRef.current === operation) {
          rotateSnapshotRef.current = null;
          setRotateSnapshot((current) => (current === operation ? null : current));
        }
        if (
          activeSecretProducerRef.current?.kind === "rotation" &&
          activeSecretProducerRef.current.operation === operation
        ) {
          activeSecretProducerRef.current = null;
        }
        setRotateErrorSnapshot((current) => (current?.operation === operation ? null : current));
        if (isSameTokenTarget(activeTargetRef.current, operation.target)) refresh();
      } catch (error) {
        const details = stashErrorDetails(error);
        if (details.code === "already-rotated") {
          if (details.successorId !== undefined) markAlreadyRotated(operation, details.successorId);
          if (isSameTokenTarget(activeTargetRef.current, operation.target)) refresh();
        }
        if (rotateSnapshotRef.current === operation) {
          setRotateErrorSnapshot({ operation, error });
        }
        throw error;
      } finally {
        activeRotateAttemptsRef.current = activeRotateAttemptsRef.current.filter(
          (current) => current !== attempt,
        );
        setRotateAttempts((current) => current.filter((item) => item !== attempt));
        if (
          rotateSnapshotRef.current === operation &&
          !isSameTokenTarget(activeTargetRef.current, operation.target)
        ) {
          rotateSnapshotRef.current = null;
          if (
            activeSecretProducerRef.current?.kind === "rotation" &&
            activeSecretProducerRef.current.operation === operation
          ) {
            activeSecretProducerRef.current = null;
          }
          setRotateSnapshot((current) => (current === operation ? null : current));
          setRotateErrorSnapshot((current) => (current?.operation === operation ? null : current));
        }
      }
    })();
    attempt.completion = completion;
    return completion;
  }

  function closeRevoke(operation: RevokeSnapshot) {
    if (
      activeRevokeAttemptsRef.current.some((attempt) => attempt.operation === operation) ||
      revokeSnapshotRef.current !== operation
    ) {
      return;
    }
    revokeSnapshotRef.current = null;
    setRevokeSnapshot((current) => (current === operation ? null : current));
    setRevokeErrorSnapshot((current) => (current?.operation === operation ? null : current));
  }

  function handleRevoke(operation: RevokeSnapshot): Promise<void> {
    const existingAttempt = activeRevokeAttemptsRef.current.find((attempt) =>
      isSameRevokeSubject(attempt.operation, operation),
    );
    if (existingAttempt !== undefined) {
      return existingAttempt.completion ?? Promise.resolve();
    }

    const attempt: RevokeAttempt = {
      operation,
    };
    activeRevokeAttemptsRef.current = [...activeRevokeAttemptsRef.current, attempt];
    setRevokeAttempts((current) => [...current, attempt]);
    setRevokeErrorSnapshot((current) => (current?.operation === operation ? null : current));

    const completion = (async () => {
      try {
        const result = await operation.target.client.stashes
          .tokens(operation.target.stash)
          .revoke(operation.token.id);
        if (!result.ok) throw result;

        if (revokeSnapshotRef.current === operation) {
          revokeSnapshotRef.current = null;
          setRevokeSnapshot((current) => (current === operation ? null : current));
        }
        setRevokeErrorSnapshot((current) => (current?.operation === operation ? null : current));
        if (isSameTokenTarget(activeTargetRef.current, operation.target)) refresh();
      } catch (error) {
        if (revokeSnapshotRef.current === operation) {
          setRevokeErrorSnapshot({ operation, error });
        }
        throw error;
      } finally {
        activeRevokeAttemptsRef.current = activeRevokeAttemptsRef.current.filter(
          (current) => current !== attempt,
        );
        setRevokeAttempts((current) => current.filter((item) => item !== attempt));
      }
    })();
    attempt.completion = completion;
    return completion;
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

      <MintTokenForm
        disabled={
          mintAttempt !== null ||
          rotateSnapshot !== null ||
          rotateAttempts.length > 0 ||
          secretSnapshot !== null
        }
        targetKey={target}
        onMint={handleMint}
      />

      {visibleSecret ? (
        <OneTimeSecret
          key={visibleSecret.token}
          kind={visibleSecret.kind}
          originStash={visibleSecret.originStash}
          successorId={visibleSecret.successorId}
          token={visibleSecret.token}
          onDismiss={() => {
            if (secretSnapshotRef.current !== visibleSecret) return;
            secretSnapshotRef.current = null;
            setSecretSnapshot((current) => (current === visibleSecret ? null : current));
          }}
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
            rotateDisabled={
              mintAttempt !== null || rotateAttempts.length > 0 || secretSnapshot !== null
            }
            stash={stash}
            tokens={listResult.tokens}
            onRotate={selectRotate}
            onRevoke={selectRevoke}
          />
        ) : null}
      </section>

      {visibleRotate ? (
        <RotateTokenDialog
          key={`${visibleRotate.target.stash}:${visibleRotate.token.id}`}
          error={visibleRotateError}
          open={true}
          operationKey={visibleRotate}
          pending={visibleRotateAttempt !== null}
          token={visibleRotate.token}
          onClose={() => closeRotate(visibleRotate)}
          onConfirm={(input) => handleRotate(visibleRotate, input)}
        />
      ) : null}

      {visibleRevoke ? (
        <RevokeTokenDialog
          key={visibleRevoke.token.id}
          error={visibleRevokeError}
          open={true}
          operationKey={visibleRevoke}
          pending={visibleRevokeAttempt !== null}
          token={visibleRevoke.token}
          onClose={() => closeRevoke(visibleRevoke)}
          onConfirm={() => handleRevoke(visibleRevoke)}
        />
      ) : null}
    </section>
  );
}
