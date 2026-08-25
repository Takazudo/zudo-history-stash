import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useStashClient } from "../auth/stash-client-provider.js";
import { Button } from "./button.js";

const THEME_STORAGE_KEY = "zhs.theme";
type Theme = "light" | "dark";

function initialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    // A system-derived theme is still available when storage is blocked.
  }
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function Header({ breadcrumb, status }: { breadcrumb?: ReactNode; status?: ReactNode }) {
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
        {status ? <span className="app-header__status">{status}</span> : null}
        <Button compact onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
          {theme === "dark" ? "Light theme" : "Dark theme"}
        </Button>
        <Button compact onClick={logOut}>
          Log out
        </Button>
      </div>
    </header>
  );
}
