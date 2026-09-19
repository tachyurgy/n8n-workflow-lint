#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { lint, rules } from '../src/index.js';

const USAGE = `n8n-workflow-lint — production-readiness checks for n8n workflow JSON

Usage:
  n8n-workflow-lint <file.json|dir> [...]     lint one or more exports (dirs are scanned for *.json)
  n8n-workflow-lint --rules                    list rules with the failure each one prevents
  cat workflow.json | n8n-workflow-lint -      read from stdin

Options:
  --json               machine-readable output
  --min-score <n>      exit 1 if any workflow scores below n (default: 0)
  --fail-on <level>    exit 1 if any finding is at or above error|warn|info (default: error)
  --only <ids>         comma-separated rule ids to run
  --ignore <ids>       comma-separated rule ids to skip
  --quiet              only print the summary line per workflow
`;

const args = process.argv.slice(2);
if (args.length === 0 || args.includes('-h') || args.includes('--help')) { process.stdout.write(USAGE); process.exit(0); }

const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const flag = (name) => args.includes(name);

if (flag('--rules')) {
  for (const r of rules) {
    process.stdout.write(`${pad(r.severity)} ${r.id}\n    ${r.title}\n    why: ${r.why}\n    fix: ${r.fix}\n    ref: ${r.ref}\n\n`);
  }
  process.exit(0);
}

const asJson = flag('--json');
const quiet = flag('--quiet');
const minScore = Number(opt('--min-score', 0));
const failOn = opt('--fail-on', 'error');
const only = opt('--only') ? opt('--only').split(',') : undefined;
const ignore = opt('--ignore') ? opt('--ignore').split(',') : undefined;
const skipNext = new Set(['--min-score', '--fail-on', '--only', '--ignore']);
const inputs = [];
for (let i = 0; i < args.length; i++) {
  if (skipNext.has(args[i])) { i++; continue; }
  if (args[i].startsWith('--')) continue;
  inputs.push(args[i]);
}

function* expand(p) {
  if (p === '-') { yield ['<stdin>', readFileSync(0, 'utf8')]; return; }
  if (statSync(p).isDirectory()) {
    for (const f of readdirSync(p).sort()) if (extname(f) === '.json') yield* expand(join(p, f));
    return;
  }
  yield [p, readFileSync(p, 'utf8')];
}

const results = [];
for (const input of inputs) {
  for (const [file, text] of expand(input)) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { results.push({ file, error: `invalid JSON: ${e.message}` }); continue; }
    // Some exports wrap several workflows in an array, and the template API nests under .workflow
    const candidates = Array.isArray(parsed) ? parsed : [parsed.workflow?.nodes ? parsed.workflow : parsed];
    for (const wf of candidates) {
      try { results.push({ file, ...lint(wf, { only, ignore }) }); }
      catch (e) { results.push({ file, error: e.message }); }
    }
  }
}

const rank = { error: 0, warn: 1, info: 2 };
let failed = false;
for (const r of results) {
  if (r.error) { failed = true; continue; }
  if (r.score < minScore) failed = true;
  if (r.findings.some((f) => rank[f.severity] <= rank[failOn])) failed = true;
}

if (asJson) {
  process.stdout.write(JSON.stringify(results, null, 2) + '\n');
} else {
  for (const r of results) {
    if (r.error) { process.stdout.write(`${r.file}: ${r.error}\n\n`); continue; }
    const counts = { error: 0, warn: 0, info: 0 };
    for (const f of r.findings) counts[f.severity]++;
    process.stdout.write(`${r.file}  "${r.name}"  score ${r.score}/100 (${r.grade})  ${counts.error} error, ${counts.warn} warn, ${counts.info} info${r.settingsPresent ? '' : '  [no settings block: workflow-level rules skipped]'}\n`);
    if (quiet) continue;
    for (const f of r.findings) {
      process.stdout.write(`  ${pad(f.severity)} ${f.rule}${f.node ? `  @ "${f.node}"` : ''}\n        ${f.message}\n`);
    }
    if (r.findings.length) process.stdout.write('\n');
  }
  if (results.length > 1) {
    const ok = results.filter((r) => !r.error);
    const avg = ok.length ? Math.round(ok.reduce((a, r) => a + r.score, 0) / ok.length) : 0;
    process.stdout.write(`${ok.length} workflow(s), average score ${avg}. Run with --rules to see what each check prevents.\n`);
  }
}
process.exit(failed ? 1 : 0);

function pad(sev) { return ({ error: 'ERROR', warn: 'WARN ', info: 'INFO ' })[sev]; }
