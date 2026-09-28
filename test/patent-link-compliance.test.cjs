"use strict";

// Patent deep-links must go to EPO (Espacenet), never Google Patents.
//
// The curated knowledge base shipped with 14 links to patents.google.com, which
// infringes Google Patents' usage policy and contradicts our own rule. They are
// now Espacenet search URLs built from the same publication number. This test
// exists because the fix is one careless edit away from being undone: the next
// person adding a patent source will reach for whatever Google returns first.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

function readAll(dir, exts) {
  return fs.readdirSync(dir)
    .filter((f) => exts.some((e) => f.endsWith(e)))
    .map((f) => ({ file: path.join(dir, f), text: fs.readFileSync(path.join(dir, f), "utf8") }));
}

const SOURCES = [
  ...readAll(path.join(ROOT, "data"), [".json", ".txt"]),
  ...readAll(path.join(ROOT, "public"), [".js", ".html", ".css"]),
  ...readAll(path.join(ROOT, "lib"), [".js"]),
];

test("no source links to Google Patents", () => {
  const offenders = SOURCES.filter((s) => /patents\.google\.com/i.test(s.text));
  assert.deepStrictEqual(
    offenders.map((o) => path.relative(ROOT, o.file)),
    [],
    "patent links must point at EPO (Espacenet), not Google Patents"
  );
});

test("patent deep-links land on the document, not on a search box", () => {
  // Curated links only: lib/epoOps.js holds the URL *templates*, which have no
  // publication number until a document is rendered, so they are checked
  // separately in test/patent-link-target.test.cjs.
  //
  // Two approved hosts now: Espacenet (everything non-US) and the USPTO's own
  // document server (US publications). Espacenet enforces a Fair Use policy
  // against the BROWSER and 403s shared corporate egress, which left users
  // looking at "rejected due to the violation of Fair Use policy" instead of the
  // patent, while OPS itself stayed perfectly healthy.
  const links = readAll(path.join(ROOT, "data"), [".json", ".txt"])
    .flatMap((s) => (s.text.match(/https:\/\/(?:worldwide\.espacenet\.com|image-ppubs\.uspto\.gov)\/[^"\s)]+/g) || []));
  const patents = links.filter((l) => l.includes("/patent/") || l.includes("/print/downloadPdf/"));
  assert.ok(patents.length >= 14, `expected the curated patent links, found ${patents.length}`);
  // Anything claiming to be a patent must carry a publication number, so it
  // resolves to the document rather than to a search box.
  const bare = patents.filter((l) =>
    !/q=pn%3D[A-Z]{2}[0-9A-Z]+/.test(l) && !/\/print\/downloadPdf\/\d+$/.test(l));
  assert.deepStrictEqual(bare, [], `patent links must carry a publication number: ${bare.join(", ")}`);
});

test("the client builds Espacenet links too, not just the data", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib", "epoOps.js"), "utf8");
  assert.ok(/worldwide\.espacenet\.com/.test(src), "search results must deep-link to Espacenet");
  assert.ok(!/patents\.google\.com/.test(src), "and never to Google Patents");
});

test("attribution still credits EPO OPS where live data is shown", () => {
  const srv = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  assert.ok(/Data: EPO OPS/.test(srv), "live patent data must keep its EPO OPS attribution");
});
