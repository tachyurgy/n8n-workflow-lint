import { buildModel } from './model.js';
import { rules } from './rules/index.js';

export { rules };

const WEIGHT = { error: 12, warn: 5, info: 1 };

// Score is 100 minus a weighted count of findings, floored at 0. Repeated findings of the
// same rule cost less each time so one missing-retry pattern across 20 HTTP nodes does not
// zero a workflow that is otherwise sound.
export function score(findings) {
  let total = 0;
  const seen = {};
  for (const f of findings) {
    seen[f.rule] = (seen[f.rule] ?? 0) + 1;
    total += WEIGHT[f.severity] / Math.sqrt(seen[f.rule]);
  }
  return Math.max(0, Math.round(100 - total));
}

export function grade(s) {
  return s >= 90 ? 'A' : s >= 75 ? 'B' : s >= 60 ? 'C' : s >= 40 ? 'D' : 'F';
}

/**
 * Lint one workflow export (the object you get from "Download" or the public API).
 * @returns {{ name:string, score:number, grade:string, findings:Array, nodes:number, settingsPresent:boolean }}
 */
export function lint(workflow, { only, ignore } = {}) {
  if (!workflow || typeof workflow !== 'object' || !Array.isArray(workflow.nodes)) {
    throw new Error('not an n8n workflow export: expected an object with a "nodes" array');
  }
  const model = buildModel(workflow);
  const findings = [];
  for (const rule of rules) {
    if (only && !only.includes(rule.id)) continue;
    if (ignore && ignore.includes(rule.id)) continue;
    for (const hit of rule.check(model)) {
      findings.push({ rule: rule.id, severity: rule.severity, title: rule.title, node: hit.node ?? null, message: hit.message, fix: rule.fix, ref: rule.ref });
    }
  }
  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.rule.localeCompare(b.rule));
  const s = score(findings);
  return { name: workflow.name ?? '(unnamed)', score: s, grade: grade(s), findings, nodes: model.nodes.length, settingsPresent: workflow.settings !== undefined };
}
