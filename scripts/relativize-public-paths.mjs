// Optional post-build pass for hosting the docs somewhere that isn't the domain root (for example a prototype
// host that serves each upload under its own path). Not part of the production deploy, which is served from
// https://glide.valkey.io/.
//
// Astro output links to root-absolute paths (`/_astro/common.css`, `/overview/`) and to absolute
// `https://glide.valkey.io/...` URLs. Both ignore the directory the site is mounted in. This rewrites them, in
// every HTML and CSS file under the output directory, to paths relative to that file, with the right number of
// "../". Targets that aren't in the output (for example the Javadoc, which is published separately) are left
// alone.
//
// Usage, after `astro build` (Starlight builds the Pagefind index as part of it):
//   node scripts/relativize-public-paths.mjs [dist]
//
// Idempotent: it only touches values that start with a single "/" or with the site's base URL.
// Left alone: <link rel="canonical"> and <link rel="alternate"> (they should stay absolute).
//
// The search box loads Pagefind from a root-absolute path hardcoded in Starlight's bundled Search script, and
// Pagefind stores each result's URL as a root-absolute path. Both are resolved against the script's own URL
// instead.

import { existsSync, statSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] ?? "dist");
const BASE_URL = "https://glide.valkey.io";

async function* walk(dir, extensions) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, extensions);
    else if (extensions.some((ext) => entry.name.endsWith(ext))) yield full;
  }
}

function prefixFor(file) {
  const depth = path.relative(ROOT, file).split(path.sep).length - 1;
  return "../".repeat(depth);
}

// Returns the root-absolute form of value ("/overview/"), or null if it points somewhere else.
function asRootPath(value) {
  if (value === BASE_URL) return "/";
  if (value.startsWith(`${BASE_URL}/`)) return value.slice(BASE_URL.length);
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  return null;
}

// Directory-style targets get an explicit index.html: static hosts don't all serve index.html for directories.
function toTarget(pathPart) {
  return pathPart === "" || pathPart.endsWith("/") ? `${pathPart}index.html` : pathPart;
}

function existsInOutput(target) {
  const full = path.join(ROOT, decodeURIComponent(target));
  return existsSync(full) && statSync(full).isFile();
}

function relativize(value, prefix) {
  const rootPath = asRootPath(value);
  if (rootPath === null) return null;
  const [, pathPart, tail] = rootPath.slice(1).match(/^([^?#]*)(.*)$/);
  let target = toTarget(pathPart);
  // Extensionless links to a directory ("/getting-started/quickstart?lang=go") point at its index.html.
  if (!existsInOutput(target) && existsInOutput(`${pathPart}/index.html`)) target = `${pathPart}/index.html`;
  if (!existsInOutput(target)) return null;
  return prefix + target + tail;
}

function rewriteTag(tag, prefix, count) {
  if (/\brel="(?:canonical|alternate)"/.test(tag)) return tag;
  tag = tag.replace(/\b((?:href|src)=")([^"]*)(")/g, (m, open, value, close) => {
    const next = relativize(value, prefix);
    if (next === null) return m;
    count.n++;
    return open + next + close;
  });
  return tag.replace(/\b(srcset=")([^"]*)(")/g, (m, open, value, close) => {
    const parts = value.split(",").map((entry) => {
      const [url, ...descriptor] = entry.trim().split(/\s+/);
      const next = relativize(url, prefix);
      if (next === null) return entry.trim();
      count.n++;
      return [next, ...descriptor].join(" ");
    });
    return open + parts.join(", ") + close;
  });
}

function rewriteCssUrls(content, prefix, count) {
  return content.replace(/url\(\s*(['"]?)(\/[^)'"]*)\1\s*\)/g, (m, quote, value) => {
    const next = relativize(value, prefix);
    if (next === null) return m;
    count.n++;
    return `url(${quote}${next}${quote})`;
  });
}

// Starlight's bundled Search script lives in /_astro/. Point Pagefind at the index next to it, and at the site
// root as mounted (the script's parent directory) so result URLs resolve there too. Directory-style result URLs
// get an explicit index.html, like the rewritten links.
const RESULT_URL_HELPER = `
function __indexHtml(p){return p.replace(/^([^?#]*\\/)(?=$|[?#])/,"$1index.html")}
`;

function rewriteSearchScript(content, count) {
  if (content.includes("__indexHtml")) return content;
  const patched = content
    .replace(/bundlePath:`\/`\.replace\(\/\\\/\$\/,``\)\+`\/pagefind\/`/, 'bundlePath:new URL("../pagefind/",import.meta.url).pathname')
    .replace(/baseUrl:`\/`/, 'baseUrl:new URL("../",import.meta.url).pathname')
    .replace(/(\w)\.url=(\w+)\(\1\.url\)/g, "$1.url=__indexHtml($2($1.url))");
  if (patched === content) return content;
  count.n++;
  return patched + RESULT_URL_HELPER;
}

const count = { n: 0 };
let files = 0;

async function update(file, transform) {
  const before = await fs.readFile(file, "utf8");
  const start = count.n;
  const after = transform(before);
  if (count.n > start && after !== before) {
    await fs.writeFile(file, after);
    files++;
  }
}

for await (const file of walk(ROOT, [".html"])) {
  const prefix = prefixFor(file);
  await update(file, (content) => {
    content = content.replace(/<[a-zA-Z][^>]*>/g, (tag) => rewriteTag(tag, prefix, count));
    // Inline style blocks and style attributes.
    return rewriteCssUrls(content, prefix, count);
  });
}

for await (const file of walk(ROOT, [".css"])) {
  const prefix = prefixFor(file);
  await update(file, (content) => rewriteCssUrls(content, prefix, count));
}

for await (const file of walk(path.join(ROOT, "_astro"), [".js"])) {
  if (!path.basename(file).startsWith("Search.astro_astro_type_script")) continue;
  await update(file, (content) => rewriteSearchScript(content, count));
}

console.log(`[relativize-public-paths] rewrote ${count.n} path(s) across ${files} file(s) in ${ROOT}`);
