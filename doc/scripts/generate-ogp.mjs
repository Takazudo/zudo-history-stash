#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const output = fileURLToPath(new URL("../public/img/ogp.png", import.meta.url));

const glyphs = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function pixelText(text, x, y, size, fill) {
  const rectangles = [];
  let cursor = x;
  for (const character of text) {
    if (character === " ") {
      cursor += size * 4;
      continue;
    }
    const glyph = glyphs[character];
    if (!glyph) throw new Error(`Unsupported OGP glyph: ${character}`);
    glyph.forEach((row, rowIndex) => {
      [...row].forEach((pixel, columnIndex) => {
        if (pixel === "1") {
          rectangles.push(
            `<rect x="${cursor + columnIndex * size}" y="${y + rowIndex * size}" width="${size}" height="${size}" rx="${size / 5}" />`,
          );
        }
      });
    });
    cursor += size * 6;
  }
  return `<g fill="${fill}">${rectangles.join("")}</g>`;
}

// PLACEHOLDER: keep the source and generated card intentionally obvious until design replaces it.
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <title>zudo-history-stash documentation OGP placeholder</title>
  <rect width="1200" height="630" fill="#0a0d14" />
  <path d="M0 0H1200V28H0zM0 602H1200V630H0z" fill="#53e0c1" />
  <circle cx="1050" cy="116" r="160" fill="#19233a" />
  <circle cx="1050" cy="116" r="96" fill="#24314d" />
  ${pixelText("ZUDO HISTORY STASH", 84, 172, 10, "#f7f9ff")}
  ${pixelText("DOCS OGP PLACEHOLDER", 84, 350, 7, "#53e0c1")}
</svg>`;

const png = new Resvg(svg).render().asPng();
await mkdir(dirname(output), { recursive: true });
await writeFile(output, png);
console.log(`Wrote ${output}`);
