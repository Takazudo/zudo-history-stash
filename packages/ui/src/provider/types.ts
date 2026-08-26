import type { ApiError, MeResponse } from "@takazudo/zudo-history-stash";
import type { AnchorHTMLAttributes, ComponentType, ReactNode } from "react";

export type StashUiRoute =
  | { kind: "home" }
  | { kind: "stash"; stash: string }
  | { kind: "file"; stash: string; path: string; version?: number }
  | {
      kind: "diff";
      stash: string;
      path: string;
      from: number;
      to: number | "head";
      context?: number;
    }
  | { kind: "edit"; stash: string; path: string; from?: number }
  | { kind: "new-file"; stash: string }
  | { kind: "tokens"; stash: string };

export type StashHrefFor = (route: StashUiRoute) => string;

export type StashAnchorProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
  href: string;
  children?: ReactNode;
};

export type StashAnchorComponent = ComponentType<StashAnchorProps>;

export type StashMeState =
  | { ready: false; me: null; error: null }
  | { ready: true; me: MeResponse; error: null }
  | { ready: true; me: null; error: ApiError | Error };

export interface CanWriteState {
  ready: boolean;
  canWrite: boolean;
}

export interface IsAdminState {
  ready: boolean;
  isAdmin: boolean;
}
