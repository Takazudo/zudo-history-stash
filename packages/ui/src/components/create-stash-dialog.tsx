import { validateStashName } from "@takazudo/zudo-history-stash-core";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Button } from "../primitives/button.js";
import { Dialog } from "../primitives/dialog.js";
import { Input } from "../primitives/input.js";
import { Notice } from "../primitives/notice.js";
import { Textarea } from "../primitives/textarea.js";
import { useIsAdmin, useStashClient } from "../provider/hooks.js";
import { stashErrorMessage } from "./error-banner.js";

type SubmitError = { kind: "exists" } | { kind: "request"; message: string };

export interface CreateStashDialogProps {
  open: boolean;
  onClose: () => void;
  onCreated: (name: string) => void;
}

export function CreateStashDialog({ open, onClose, onCreated }: CreateStashDialogProps) {
  const client = useStashClient();
  const { ready, isAdmin } = useIsAdmin();
  const titleId = useId();
  const descriptionId = useId();
  const nameId = useId();
  const nameHintId = useId();
  const nameErrorId = useId();
  const stashDescriptionId = useId();
  const submittingRef = useRef(false);
  const lifecycleRef = useRef(0);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);

  useEffect(() => {
    lifecycleRef.current += 1;

    if (!isAdmin) {
      submittingRef.current = false;
      setSubmitting(false);
    }

    return () => {
      lifecycleRef.current += 1;
    };
  }, [client, isAdmin]);

  const validation = validateStashName(name);
  const validationMessage = validation.ok ? null : validation.message;
  const validationVisible = name.length > 0 && !validation.ok;
  const existsVisible = submitError?.kind === "exists";
  const nameHasError = validationVisible || existsVisible;
  const describedBy = nameHasError ? `${nameHintId} ${nameErrorId}` : nameHintId;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!open || !ready || !isAdmin || !validation.ok || submittingRef.current) return;

    submittingRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    const attempt = lifecycleRef.current + 1;
    lifecycleRef.current = attempt;
    let created = false;

    try {
      const trimmedDescription = description.trim();
      const result = await client.stashes.create({
        name,
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
      });
      if (lifecycleRef.current !== attempt) return;
      if (!result.ok) {
        setSubmitError(
          result.error.code === "exists"
            ? { kind: "exists" }
            : { kind: "request", message: stashErrorMessage(result) },
        );
        return;
      }
      created = true;
    } catch (error: unknown) {
      if (lifecycleRef.current === attempt) {
        setSubmitError({ kind: "request", message: stashErrorMessage(error) });
      }
    } finally {
      if (lifecycleRef.current === attempt) {
        submittingRef.current = false;
        setSubmitting(false);
      }
    }

    if (created && lifecycleRef.current === attempt) {
      const createdName = name;
      setName("");
      setDescription("");
      onCreated(createdName);
    }
  }

  if (!ready || !isAdmin) return null;

  return (
    <Dialog
      className="zhs-create-stash-dialog"
      open={open}
      onClose={onClose}
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
    >
      <form
        className="zhs-create-stash-dialog__form"
        aria-busy={submitting ? "true" : undefined}
        noValidate
        onSubmit={handleSubmit}
      >
        <header className="zhs-create-stash-dialog__header">
          <h2 className="zhs-create-stash-dialog__title" id={titleId}>
            Create stash
          </h2>
          <p className="zhs-create-stash-dialog__intro" id={descriptionId}>
            Create an empty namespace for versioned files.
          </p>
        </header>

        <div className="zhs-create-stash-dialog__body">
          <div className="zhs-create-stash-dialog__field">
            <label className="zhs-create-stash-dialog__label" htmlFor={nameId}>
              Name
            </label>
            <Input
              autoComplete="off"
              id={nameId}
              name="name"
              required
              spellCheck={false}
              value={name}
              aria-describedby={describedBy}
              aria-invalid={nameHasError || undefined}
              disabled={submitting}
              onChange={(event) => {
                setName(event.currentTarget.value);
                setSubmitError(null);
              }}
            />
            <p className="zhs-create-stash-dialog__hint" id={nameHintId}>
              Use lowercase letters, numbers, and hyphens; maximum 63 characters.
            </p>
            {nameHasError ? (
              <p className="zhs-create-stash-dialog__field-error" id={nameErrorId} role="alert">
                {existsVisible ? "A stash with that name already exists." : validationMessage}
              </p>
            ) : null}
          </div>

          <div className="zhs-create-stash-dialog__field">
            <label className="zhs-create-stash-dialog__label" htmlFor={stashDescriptionId}>
              Description <span className="zhs-create-stash-dialog__optional">(optional)</span>
            </label>
            <Textarea
              id={stashDescriptionId}
              name="description"
              rows={4}
              value={description}
              disabled={submitting}
              onChange={(event) => setDescription(event.currentTarget.value)}
            />
          </div>

          {submitError?.kind === "request" ? (
            <Notice className="zhs-create-stash-dialog__request-error" variant="error">
              {submitError.message}
            </Notice>
          ) : null}
        </div>

        <footer className="zhs-create-stash-dialog__actions">
          <Button disabled={submitting} onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!validation.ok || submitting} type="submit" variant="primary">
            {submitting ? "Creating…" : "Create stash"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}
