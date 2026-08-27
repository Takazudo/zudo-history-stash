export function isWellFormedString(text: string): boolean {
  return text.isWellFormed();
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

export async function sha256Hex(input: string | BufferSource): Promise<string> {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
  return `sha256-${hex}`;
}
