#!/usr/bin/env node
// Stage only the files the native app actually ships into a clean www/ dir,
// which Capacitor's webDir points at. Keeping this separate from the repo root
// stops `cap copy` from slurping .git/, node_modules/, tools/, android/, etc.
//
// The app is MOBILE-ONLY: classic.html and classic-style.css are deliberately
// NOT copied (the in-app "Switch to Classic UI" link is hidden — see
// wireUiSwitchLink in js/init.js).
import { cp, rm, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'www');

// Files/dirs to ship. `js/` includes the vendored peerjs/qrcode and native.js.
const INCLUDE = [
  'index.html',
  'styles.css',
  'sprites.png',
  'logo.png',
  'js',
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

for (const entry of INCLUDE) {
  const src = join(root, entry);
  if (!existsSync(src)) {
    console.error(`build-web: missing "${entry}" — aborting.`);
    process.exit(1);
  }
  await cp(src, join(out, entry), { recursive: true });
}

console.log(`build-web: staged ${INCLUDE.length} entries into www/`);
