ALTER TABLE tokens ADD COLUMN expires_at INTEGER; /* Epoch milliseconds; NULL never expires. */
ALTER TABLE tokens ADD COLUMN rotated_from TEXT;  /* Predecessor token ID; NULL for direct minting. */
ALTER TABLE tokens ADD COLUMN rotated_to TEXT;    /* Successor token ID; NULL until rotation. */
CREATE INDEX tokens_expires ON tokens (expires_at);
