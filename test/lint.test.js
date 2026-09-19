import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lint, rules } from '../src/index.js';

const load = (f) => JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8'));
const ids = (r) => new Set(r.findings.map((f) => f.rule));

test('a hardened workflow scores 100 with no findings', () => {
  const r = lint(load('good.json'));
  assert.equal(r.findings.length, 0, JSON.stringify(r.findings, null, 1));
  assert.equal(r.score, 100);
  assert.equal(r.grade, 'A');
});

test('a sloppy workflow trips every rule it should', () => {
  const r = lint(load('bad.json'));
  const got = ids(r);
  for (const id of ['no-error-workflow', 'http-no-retry', 'http-no-timeout', 'swallowed-error', 'agent-unguarded',
    'dead-end-branch', 'unasserted-write', 'code-swallows-error', 'hardcoded-secret', 'webhook-no-auth',
    'success-executions-not-saved', 'no-execution-timeout', 'orphan-node', 'disabled-node', 'legacy-execution-order']) {
    assert.ok(got.has(id), `expected ${id}; got ${[...got].join(', ')}`);
  }
  assert.ok(r.score < 40, `score ${r.score}`);
  assert.equal(r.grade, 'F');
  // sticky notes are not nodes
  assert.equal(r.nodes, 8);
});

test('every rule fires on bad.json and none on good.json (no dead rules)', () => {
  const bad = ids(lint(load('bad.json')));
  for (const rule of rules) assert.ok(bad.has(rule.id), `rule ${rule.id} never fires`);
});

test('template exports without a settings block skip workflow-level rules', () => {
  const wf = load('bad.json'); delete wf.settings;
  const r = lint(wf);
  assert.equal(r.settingsPresent, false);
  for (const id of ['no-error-workflow', 'success-executions-not-saved', 'no-execution-timeout', 'legacy-execution-order']) assert.ok(!ids(r).has(id), id);
});

test('an error workflow itself is not asked for an error workflow', () => {
  const wf = load('good.json');
  delete wf.settings.errorWorkflow;
  wf.nodes.push({ name: 'Error Trigger', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [0, 0], parameters: {} });
  wf.connections['Error Trigger'] = { main: [[{ node: 'Fetch', type: 'main', index: 0 }]] };
  assert.ok(!ids(lint(wf)).has('no-error-workflow'));
});

test('continueRegularOutput is forgiven when the next node inspects the error', () => {
  const wf = load('bad.json');
  wf.nodes.find((n) => n.name === 'Is ok?').parameters.conditions.conditions[0].leftValue = '={{ $json.error }}';
  assert.ok(!ids(lint(wf)).has('swallowed-error'));
});

test('a terminal agent behind a chat trigger is not unguarded', () => {
  const wf = load('bad.json');
  wf.connections['Agent'] = { main: [[]] };
  wf.nodes.push({ name: 'Chat', type: '@n8n/n8n-nodes-langchain.chatTrigger', typeVersion: 1.1, position: [0, 0], parameters: {} });
  assert.ok(!ids(lint(wf)).has('agent-unguarded'));
});

test('only / ignore filters', () => {
  const wf = load('bad.json');
  assert.deepEqual([...ids(lint(wf, { only: ['webhook-no-auth'] }))], ['webhook-no-auth']);
  assert.ok(!ids(lint(wf, { ignore: ['webhook-no-auth'] })).has('webhook-no-auth'));
});

test('rejects things that are not workflows', () => {
  assert.throws(() => lint({ hello: 1 }), /nodes/);
});
