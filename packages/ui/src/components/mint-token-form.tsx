import type { CreateTokenBody, TokenScope } from "@takazudo/zudo-history-stash";
import { useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../primitives/button.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import { Select } from "../primitives/select.js";
import { ErrorBanner } from "./error-banner.js";

export interface MintTokenFormProps {
  onMint: (input: CreateTokenBody) => Promise<void>;
}

export function MintTokenForm({ onMint }: MintTokenFormProps) {
  const titleId = useId();
  const [label, setLabel] = useState("");
  const [scope, setScope] = useState<TokenScope>("read");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown | null>(null);
  const submittingRef = useRef(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;

    submittingRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const normalizedLabel = label.trim();
      await onMint({
        scope,
        ...(normalizedLabel ? { label: normalizedLabel } : {}),
      });
      setLabel("");
      setScope("read");
    } catch (requestError) {
      setError(requestError);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
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
            disabled={submitting}
            name="label"
            value={label}
            onChange={(event) => setLabel(event.currentTarget.value)}
          />
        </label>
        <label className="zhs-tokens-field">
          <span className="zhs-tokens-field__label">Scope</span>
          <Select
            disabled={submitting}
            name="scope"
            value={scope}
            onChange={(event) => setScope(event.currentTarget.value as TokenScope)}
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
          <Button disabled={submitting} type="submit" variant="primary">
            {submitting ? "Minting…" : "Mint token"}
          </Button>
        </div>
      </form>
    </section>
  );
}
