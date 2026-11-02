#!/usr/bin/env node
/*
 * Cache-bust the app's static assets for a deploy.
 *
 * Netlify runs this as the build command. It rewrites public/index.html so
 * style.css, parse.js and app.js are referenced with ?v=<commit> and the
 * footer shows the build. Browsers then fetch new files on the next visit
 * instead of serving a stale cached copy until a hard reload.
 *
 * Safe to run repeatedly; a previous stamp is replaced.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function version() {
  if (process.env.COMMIT_REF) return process.env.COMMIT_REF.slice(0, 8);
  try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch (e) { /* not a git checkout */ }
  return String(Date.now());
}

const v = version();
const file = path.join(__dirname, '..', 'public', 'index.html');
let html = fs.readFileSync(file, 'utf8');
html = html.replace(/\b(href|src)="(style\.css|parse\.js|app\.js)(?:\?v=[^"]*)?"/g, (m, attr, name) => `${attr}="${name}?v=${v}"`);
html = html.replace(/(<span id="build"[^>]*>)[^<]*(<\/span>)/, `$1build ${v}$2`);
fs.writeFileSync(file, html);
console.log('stamped public/index.html with version ' + v);
