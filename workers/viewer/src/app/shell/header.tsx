import { LiveIndicator, type LiveChangesStatus } from "@takazudo/zudo-history-stash-ui";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useStashClient } from "../auth/stash-client-provider.js";
import { Button } from "./button.js";

const THEME_STORAGE_KEY = "zhs.theme";
type Theme = "system" | "light" | "dark";

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "system" || stored === "light" || stored === "dark") return stored;
  } catch {
    // The default dark scheme remains available when storage is blocked.
  }
  return "dark";
}

function nextTheme(theme: Theme): Theme {
  if (theme === "system") return "light";
  if (theme === "light") return "dark";
  return "system";
}

export function Header({
  breadcrumb,
  liveStatus,
  status,
}: {
  breadcrumb?: ReactNode;
  liveStatus?: LiveChangesStatus;
  status?: ReactNode;
}) {
  const { logOut } = useStashClient();
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The visible theme still changes when persistence is unavailable.
    }
  }, [theme]);

  return (
    <header className="app-header">
      <div className="app-header__identity">
        <Link className="app-header__product" to="/">
          History Stash
        </Link>
        {breadcrumb ? <span className="app-header__breadcrumb">/ {breadcrumb}</span> : null}
      </div>
      <div className="app-header__actions">
        {liveStatus ? <LiveIndicator className="app-header__live" status={liveStatus} /> : null}
        {status ? <span className="app-header__status">{status}</span> : null}
        <Button
          aria-live="polite"
          compact
          onClick={() => setTheme((current) => nextTheme(current))}
          title={`Theme: ${theme}. Activate to use ${nextTheme(theme)}.`}
        >
          Theme: {theme}
        </Button>
        <Button compact onClick={logOut}>
          Log out
        </Button>
      </div>
    </header>
  );
}
