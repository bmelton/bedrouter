// Loads ./.env (or $BEDROUTER_ENV) into process.env before anything reads it. Import this module first.
// Existing environment variables win over the file, so `AWS_PROFILE=work npm start` still overrides a committed default.
import fs from "node:fs";

export function loadEnv(path = process.env.BEDROUTER_ENV ?? ".env"): string[] {
  if (!fs.existsSync(path)) return [];
  const set: string[] = [];
  for (const raw of fs.readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    const q = value[0];
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, "");
    if (process.env[m[1]] === undefined) { process.env[m[1]] = value; set.push(m[1]); }
  }
  return set;
}

loadEnv();
