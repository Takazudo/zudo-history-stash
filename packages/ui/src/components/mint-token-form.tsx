import type { CreateTokenBody, TokenScope } from "@takazudo/zudo-history-stash";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../primitives/button.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import { Select } from "../primitives/select.js";
import { ErrorBanner } from "./error-banner.js";

export interface MintTokenFormProps {
  disabled?: boolean;
  onMint: (input: CreateTokenBody) => Promise<void>;
  targetKey: object;
}

interface MintDraft {
  targetKey: object;
  label: string;
  scope: TokenScope;
  expiry: MintExpiry;
  customExpiresAt: string;
}

type MintExpiry = "never" | "day" | "month" | "year" | "custom";

const TTL_SECONDS: Record<Exclude<MintExpiry, "never" | "custom">, number> = {
  day: 86_400,
  month: 2_592_000,
  year: 31_536_000,
};

function initialDraft(targetKey: object): MintDraft {
  return { targetKey, label: "", scope: "read", expiry: "never", customExpiresAt: "" };
}

function expirationInput(expiry: MintExpiry, customExpiresAt: string) {
  if (expiry === "never") return {};
  if (expiry === "custom") return { expiresAt: customExpiresAt.trim() };
  return { ttlSeconds: TTL_SECONDS[expiry] };
}

interface MintOperation {
  targetKey: object;
  generation: number;
}

type MintOperationSnapshot =
  | { operation: MintOperation; state: "submitting" }
  | { operation: MintOperation; state: "error"; error: unknown };

export function MintTokenForm({ disabled = false, onMint, targetKey }: MintTokenFormProps) {
  const titleId = useId();
  const operationGenerationRef = useRef(0);
  const activeOperationRef = useRef<MintOperation | null>(null);
  const [draft, setDraft] = useState<MintDraft>(() => initialDraft(targetKey));
  const [operationSnapshot, setOperationSnapshot] = useState<MintOperationSnapshot | null>(null);
  const label = draft.targetKey === targetKey ? draft.label : "";
  const scope = draft.targetKey === targetKey ? draft.scope : "read";
  const expiry = draft.targetKey === targetKey ? draft.expiry : "never";
  const customExpiresAt = draft.targetKey === targetKey ? draft.customExpiresAt : "";
  const submitting = operationSnapshot?.state === "submitting";
  const error =
    operationSnapshot?.operation.targetKey === targetKey && operationSnapshot.state === "error"
      ? operationSnapshot.error
      : null;
  const controlsDisabled = disabled || submitting;

  function isCurrentOperation(operation: MintOperation): boolean {
    return (
      activeOperationRef.current?.targetKey === operation.targetKey &&
      activeOperationRef.current.generation === operation.generation
    );
  }

  function updateDraft(update: Partial<Omit<MintDraft, "targetKey">>) {
    setDraft((current) => ({
      ...(current.targetKey === targetKey ? current : initialDraft(targetKey)),
      ...update,
      targetKey,
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || activeOperationRef.current !== null) return;

    const operation: MintOperation = {
      targetKey,
      generation: ++operationGenerationRef.current,
    };
    activeOperationRef.current = operation;
    setOperationSnapshot({ operation, state: "submitting" });
    try {
      const normalizedLabel = label.trim();
      await onMint({
        scope,
        ...(normalizedLabel ? { label: normalizedLabel } : {}),
        ...expirationInput(expiry, customExpiresAt),
      });
      if (!isCurrentOperation(operation)) return;
      setDraft(initialDraft(targetKey));
      setOperationSnapshot(null);
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
    <section className="zhs-tokens-mint" aria-labelledby={titleId}>
      <div className="zhs-tokens-section-heading">
        <div>
          <h3 id={titleId}>Mint token</h3>
          <p>Create a scoped credential for this stash.</p>
        </div>
      </div>
      <form className="zhs-tokens-mint-form" onSubmit={handleSubmit}>
        <label className="zhs-tokens-field">
          <span className="zhs-tokens-field__label">Label (optional)</span>
          <Input
            autoComplete="off"
            disabled={controlsDisabled}
            name="label"
            value={label}
            onChange={(event) => updateDraft({ label: event.currentTarget.value })}
          />
        </label>
        <label className="zhs-tokens-field">
          <span className="zhs-tokens-field__label">Scope</span>
          <Select
            disabled={controlsDisabled}
            name="scope"
            value={scope}
            onChange={(event) => updateDraft({ scope: event.currentTarget.value as TokenScope })}
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
          </Select>
        </label>
        <label className="zhs-tokens-field">
          <span className="zhs-tokens-field__label">Expiry</span>
          <Select
            disabled={controlsDisabled}
            name="expiry"
            value={expiry}
            onChange={(event) => updateDraft({ expiry: event.currentTarget.value as MintExpiry })}
          >
            <option value="never">Never</option>
            <option value="day">1 day</option>
            <option value="month">30 days</option>
            <option value="year">1 year</option>
            <option value="custom">Custom ISO</option>
          </Select>
        </label>
        <div className="zhs-tokens-form-actions">
          <Button disabled={controlsDisabled} type="submit" variant="primary">
            {submitting ? "Minting…" : "Mint token"}
          </Button>
        </div>
        {expiry === "custom" ? (
          <label className="zhs-tokens-field zhs-tokens-field--custom-expiry">
            <span className="zhs-tokens-field__label">Custom expiry (ISO 8601)</span>
            <Input
              autoComplete="off"
              disabled={controlsDisabled}
              name="expiresAt"
              placeholder="2027-08-26T09:00:00.000Z"
              required
              value={customExpiresAt}
              onChange={(event) => updateDraft({ customExpiresAt: event.currentTarget.value })}
            />
          </label>
        ) : null}
        {scope === "write" ? (
          <Notice className="zhs-tokens-browser-warning" variant="warning">
            Write tokens can modify this stash. Do not expose a write token in a public browser
            application; use it only in a trusted operator surface protected by Access or
            equivalent.
          </Notice>
        ) : null}
        {error ? <ErrorBanner error={error} title="Could not mint the token" /> : null}
      </form>
    </section>
  );
}
