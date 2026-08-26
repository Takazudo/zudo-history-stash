import { Button } from "../primitives/button.js";

export interface LoadMoreProps {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}

export function LoadMore({ hasMore, loading, onLoadMore }: LoadMoreProps) {
  if (!hasMore) return null;
  return (
    <div className="zhs-load-more">
      <Button size="sm" disabled={loading} onClick={onLoadMore}>
        {loading ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}
