import type { BlobGenerationFactory } from "../../src/d1/blobs.js";

export function generation(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

export function generationFactory(...values: string[]): BlobGenerationFactory {
  let index = 0;
  return () => {
    const value = values[index];
    if (value === undefined) throw new Error("Blob generation factory exhausted");
    index += 1;
    return value;
  };
}
