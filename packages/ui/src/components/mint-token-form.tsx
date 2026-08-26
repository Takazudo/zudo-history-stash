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
  const [draft, setDraft] = useState<MintDraft>({ targetKey, label: "", scope: "read" });
  const [operationSnapshot, setOperationSnapshot] = useState<MintOperationSnapshot | null>(null);
  const label = draft.targetKey === targetKey ? draft.label : "";
  const scope = draft.targetKey === targetKey ? draft.scope : "read";
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
      });
      if (!isCurrentOperation(operation)) return;
      setDraft({ targetKey, label: "", scope: "read" });
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
            onChange={(event) => setDraft({ targetKey, label: event.currentTarget.value, scope })}
          />
        </label>
        <label className="zhs-tokens-field">
          <span className="zhs-tokens-field__label">Scope</span>
          <Select
            disabled={controlsDisabled}
            name="scope"
            value={scope}
            onChange={(event) =>
              setDraft({ targetKey, label, scope: event.currentTarget.value as TokenScope })
            }
          >
            <option value="read">Read</option>
            <option value="write">Write</option>
          </Select>
        </label>
        {scope === "write" ? (
          <Notice className="zhs-tokens-browser-warning" variant="warning">
            Write tokens can modify this stash. Do not expose a write token in a public browser
            application; use it only in a trusted operator surface protected by Access or
            equivalent.
          </Notice>
        ) : null}
        {error ? <ErrorBanner error={error} title="Could not mint the token" /> : null}
        <div className="zhs-tokens-form-actions">
          <Button disabled={controlsDisabled} type="submit" variant="primary">
            {submitting ? "Minting…" : "Mint token"}
          </Button>
        </div>
      </form>
    </section>
  );
}
