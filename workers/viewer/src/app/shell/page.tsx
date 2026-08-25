import type { ReactNode } from "react";

export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="page">
      <header className="page__heading">
        <div className="page__title-group">
          <h1 className="page__title">{title}</h1>
          {description ? <p className="page__description">{description}</p> : null}
        </div>
        {actions}
      </header>
      <div className="page__scroll">{children}</div>
    </section>
  );
}
