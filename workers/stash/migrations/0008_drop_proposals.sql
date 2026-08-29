/* The candidate workflow is replaced by atomic commits and change sets. */
DROP INDEX IF EXISTS proposals_stash_status_created;
DROP INDEX IF EXISTS proposals_stash_path;
DROP INDEX IF EXISTS proposals_stash_idempotency;
DROP TABLE proposals;
