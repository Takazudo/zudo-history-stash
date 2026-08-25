import { createBrowserRouter, RouterProvider } from "react-router-dom";
import DiffPage from "../pages/diff.js";
import FilePage from "../pages/file.js";
import HomePage from "../pages/home.js";
import LoginPage from "../pages/login.js";
import StashPage from "../pages/stash.js";

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  { path: "/", element: <HomePage /> },
  { path: "/s/:stash", element: <StashPage /> },
  { path: "/s/:stash/f/*", element: <FilePage /> },
  { path: "/s/:stash/diff/*", element: <DiffPage /> },
]);

export function ViewerApp() {
  return <RouterProvider router={router} />;
}
