import "./env.js";
import fs from "node:fs";
import path from "node:path";
import { mergeIndex, type Prices } from "./publish.js";
import { renderHtml } from "./dashboard.js";

/**
 * `bedrouter rollup <dir> --prices <file> --out <dir>`: the command the stats repository's Action runs.
 *
 * All the logic lives in this package and is tested here, so the stats repository holds data, one workflow file and
 * a page, and nothing generated is ever committed to it: the Action builds into the Pages artifact and deploys that.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
  const takesValue = new Set(["--prices", "--out"]);
  const dir = argv.filter((a, i) => !a.startsWith("--") && !takesValue.has(argv[i - 1] ?? ""))[0] ?? "data";
  const pricesPath = opt("prices") ?? "prices.json";
  const out = opt("out") ?? "dist";

  if (!fs.existsSync(dir)) { console.error(`no data directory at ${dir}`); return 1; }
  if (!fs.existsSync(pricesPath)) { console.error(`no prices file at ${pricesPath}`); return 1; }
  const prices = JSON.parse(fs.readFileSync(pricesPath, "utf8")) as Prices;
  if (!prices?.baselineAlias || !prices.rungs) { console.error(`${pricesPath}: needs "baselineAlias" and "rungs"`); return 1; }

  const files: { path: string; body: unknown }[] = [];
  for (const login of fs.readdirSync(dir)) {
    const personDir = path.join(dir, login);
    if (!fs.statSync(personDir).isDirectory()) continue;
    for (const name of fs.readdirSync(personDir)) {
      if (!name.endsWith(".json")) continue;
      const rel = `${path.basename(dir)}/${login}/${name}`;
      try { files.push({ path: rel, body: JSON.parse(fs.readFileSync(path.join(personDir, name), "utf8")) }); }
      catch (err) { files.push({ path: rel, body: { parseError: (err as Error).message } }); }
    }
  }

  let merged;
  try { merged = mergeIndex(files, prices); }
  catch (err) {
    // The one failure that stops the build: an unpriced rung would quietly drop that rung's spend from every total.
    console.error(`rollup failed: ${(err as Error).message}`);
    return 1;
  }

  // Naming a bad file in the build log rather than failing keeps one person's mistake from taking the page down.
  for (const s of merged.skipped) console.error(`skipped ${s.file}: ${s.why}`);
  if (merged.unpriced.length) console.error(`asked-for baseline ignores unpriced alias(es): ${merged.unpriced.join(", ")}`);

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(merged.view, null, 2) + "\n");
  fs.writeFileSync(path.join(out, "index.html"), renderHtml(merged.view, { generatedAt: `${new Date().toISOString().slice(0, 19).replace("T", " ")} UTC` }));
  console.log(`rollup: ${files.length - merged.skipped.length} day file(s) from ${merged.view.byPerson?.length ?? 0} developer(s), ${merged.skipped.length} skipped -> ${out}/index.html`);
  return 0;
}
