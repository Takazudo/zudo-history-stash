import { Button } from "../app/shell/button.js";

export function LoadMore({
  hasMore,
  loading,
  onLoadMore,
}: {
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  if (!hasMore) return null;
  return (
    <div className="load-more">
      <Button compact disabled={loading} onClick={onLoadMore}>
        {loading ? "Loading…" : "Load more"}
      </Button>
    </div>
  );
}
