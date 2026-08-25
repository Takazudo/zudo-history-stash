import { useState, type FormEvent } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useStashClient } from "../app/auth/stash-client-provider.js";
import { defaultPathForPrincipal, isSafeNext } from "../app/safe-next.js";
import { Button } from "../app/shell/button.js";

export default function LoginPage() {
  const { authenticate } = useStashClient();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const candidate = token.trim();
    if (!candidate) {
      setError("Enter an admin or stash token.");
      return;
    }

    setSubmitting(true);
    setError(null);
    const result = await authenticate(candidate);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error.status === 401 ? "That token was not accepted." : result.error.message);
      return;
    }

    const next = searchParams.get("next");
    navigate(isSafeNext(next) ? next : defaultPathForPrincipal(result.value), { replace: true });
  }

  return (
    <main className="page page--standalone">
      <section className="login-card">
        <h1>Open History Stash</h1>
        <p className="login-card__intro">
          Paste a token to browse the stashes and files available to that principal.
        </p>
        <form onSubmit={handleSubmit}>
          <label className="form-field">
            <span className="form-field__label">Access token</span>
            <input
              className="form-field__input"
              name="token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={token}
              onChange={(event) => setToken(event.currentTarget.value)}
            />
            <span className="form-field__help">
              Stored only in this tab&apos;s session storage.
            </span>
          </label>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="form-actions">
            <Button disabled={submitting} type="submit" variant="primary">
              {submitting ? "Checking…" : "Continue"}
            </Button>
          </div>
        </form>
      </section>
    </main>
  );
}
