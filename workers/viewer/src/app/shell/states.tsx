import type { ReactNode } from "react";
import { Button } from "./button.js";

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="state-card" role="status">
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
    </section>
  );
}

export function ErrorState({
  title = "Something went wrong",
  children,
  onRetry,
}: {
  title?: string;
  children?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <section className="state-card" role="alert">
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {onRetry ? (
        <div className="form-actions">
          <Button onClick={onRetry}>Try again</Button>
        </div>
      ) : null}
    </section>
  );
}
