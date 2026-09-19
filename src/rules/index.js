// Every rule maps to a failure mode people actually hit in production and wrote about on
// community.n8n.io. `ref` is the thread the rule exists because of.
import { isTrigger, isWrite, isNotification } from '../model.js';

const HTTP = 'n8n-nodes-base.httpRequest';
const AGENT = '@n8n/n8n-nodes-langchain.agent';
const IF = 'n8n-nodes-base.if';
const FILTER = 'n8n-nodes-base.filter';
const SWITCH = 'n8n-nodes-base.switch';
const CODE = 'n8n-nodes-base.code';
const WEBHOOK = 'n8n-nodes-base.webhook';
const STOP = 'n8n-nodes-base.stopAndError';

// How a node behaves when it throws. n8n stores the modern setting in `onError` and the
// legacy one in `continueOnFail`.
function errorMode(node) {
  if (node.onError) return node.onError; // stopWorkflow | continueRegularOutput | continueErrorOutput
  if (node.continueOnFail === true) return 'continueRegularOutput';
  return 'stopWorkflow';
}

// Index of the "error" output for a node with continueErrorOutput: it is always the last
// main output. IF has 2 regular outputs, Switch has N, everything else 1.
function errorOutputIndex(node) {
  if (node.type === IF) return 2;
  if (node.type === SWITCH) {
    const rules = node.parameters?.rules?.values ?? node.parameters?.rules?.rules ?? [];
    const n = Array.isArray(rules) ? rules.length : 1;
    return Math.max(n, 1) + (node.parameters?.options?.fallbackOutput !== undefined ? 1 : 0);
  }
  return 1;
}

function walkStrings(value, visit, path = '') {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, visit, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walkStrings(v, visit, path ? `${path}.${k}` : k);
}

export const rules = [
  {
    id: 'no-error-workflow',
    severity: 'error',
    title: 'No error workflow is attached',
    why: 'When a node throws, the execution is marked failed and nothing else happens. Without an Error Workflow nobody is told, and the execution list is a page you have to remember to go and worry at.',
    fix: 'Workflow settings → Error Workflow → pick a workflow that starts with an Error Trigger and alerts a human (Slack, email, PagerDuty). One shared error workflow can serve every workflow on the instance.',
    ref: 'https://community.n8n.io/t/i-pointed-a-read-only-monitor-at-my-own-n8n-and-found-28-failures-id-never-looked-at/313040',
    appliesTo: 'settings',
    check(m) {
      if (m.workflow.settings === undefined) return []; // template exports strip settings; nothing to judge
      if (m.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger')) return []; // this IS an error workflow
      if (m.nodes.some((n) => n.type === 'n8n-nodes-base.executeWorkflowTrigger')) return []; // sub-workflows inherit the caller's
      if (m.nodes.every((n) => n.type === 'n8n-nodes-base.manualTrigger' || !isTrigger(n))) return []; // manual-only, not production
      return m.workflow.settings.errorWorkflow ? [] : [{ message: 'settings.errorWorkflow is not set' }];
    },
  },
  {
    id: 'http-no-retry',
    severity: 'warn',
    title: 'HTTP Request without Retry On Fail',
    why: 'Networks blip and APIs return 429/502 for a few seconds. Without node-level retry a transient error either kills the execution or, with Continue On Fail, silently produces nothing.',
    fix: 'Node settings → Retry On Fail: on, Max Tries 3, Wait Between Tries 2000–5000 ms. Retry at the node, not by re-running the whole execution, so earlier writes are not repeated.',
    ref: 'https://community.n8n.io/t/partial-failures-when-an-n8n-workflow-calls-multiple-apis/310338',
    check(m) {
      return m.nodes.filter((n) => n.type === HTTP && !n.disabled && n.retryOnFail !== true)
        .map((n) => ({ node: n.name, message: 'retryOnFail is off' }));
    },
  },
  {
    id: 'http-no-timeout',
    severity: 'warn',
    title: 'HTTP Request without a timeout',
    why: 'A hung upstream holds the execution open until the global execution timeout (or forever in queue mode). Everything behind it in the queue waits.',
    fix: 'HTTP Request → Options → Timeout (ms). 10–30 s for normal APIs; longer only for known-slow endpoints.',
    ref: 'https://community.n8n.io/t/silent-failures-in-production-how-do-you-handle-observability-global-error-handling-for-20-n8n-workflows/308805',
    check(m) {
      return m.nodes.filter((n) => n.type === HTTP && !n.disabled && !(Number(n.parameters?.options?.timeout) > 0))
        .map((n) => ({ node: n.name, message: 'options.timeout not set' }));
    },
  },
  {
    id: 'swallowed-error',
    severity: 'error',
    title: 'Node continues on error with no error branch',
    why: 'Continue (using regular output) turns every exception into a normal item that flows downstream. The execution stays green while the failure travels on as data. This is the single most common way a workflow "ran fine and did nothing".',
    fix: 'Prefer On Error → Continue (using error output) and connect the error output to a Stop and Error node or to an alert. If you must use regular output, add an IF right after the node that checks for the `error` key and routes it somewhere loud.',
    ref: 'https://community.n8n.io/t/how-do-you-catch-workflows-that-run-fine-but-do-nothing/308708',
    check(m) {
      const out = [];
      for (const n of m.nodes) {
        if (n.disabled) continue;
        const mode = errorMode(n);
        if (mode === 'continueRegularOutput') {
          // Forgiven when the next node visibly inspects the error.
          const next = m.mainOutAll(n.name).map((e) => m.byName.get(e.to));
          const inspected = next.some((t) => t && (t.type === IF || t.type === SWITCH || t.type === FILTER || t.type === CODE) &&
            /error/i.test(JSON.stringify(t.parameters ?? {})));
          if (!inspected) out.push({ node: n.name, message: 'onError=continueRegularOutput and the next node does not look at $json.error' });
        } else if (mode === 'continueErrorOutput') {
          const idx = errorOutputIndex(n);
          if (m.mainOut(n.name, idx).length === 0) out.push({ node: n.name, message: 'onError=continueErrorOutput but the error output is not connected to anything' });
        }
      }
      return out;
    },
  },
  {
    id: 'agent-unguarded',
    severity: 'error',
    title: 'AI Agent output is used without a guard',
    why: 'When a tool inside an AI Agent fails, the agent node itself still finishes green and the model fills the gap with a plausible guess. Downstream nodes then act on a confident wrong answer.',
    fix: 'Either set On Error → Continue (using error output) on the agent and wire the error branch, or follow the agent with a Code/IF node that throws when the output is empty, fails a schema check, or contains refusal phrases ("I was unable to", "I don\'t have access"). A structured output parser plus a required-fields check is the sturdier version.',
    ref: 'https://community.n8n.io/t/ai-agent-node-finishes-green-even-when-its-tool-failed-how-i-catch-it-now/300885',
    check(m) {
      const out = [];
      for (const n of m.nodes) {
        if (n.type !== AGENT || n.disabled) continue;
        const hasTools = (m.incoming.get(n.name) ?? []).some((e) => e.kind === 'ai_tool');
        if (!hasTools) continue;
        if (errorMode(n) === 'continueErrorOutput' && m.mainOut(n.name, 1).length > 0) continue;
        const next = m.mainOut(n.name, 0).map((e) => m.byName.get(e.to)).filter(Boolean);
        // A terminal agent behind a Chat Trigger answers a human who is looking at it; that is the guard.
        const chatUi = m.nodes.some((t) => t.type === '@n8n/n8n-nodes-langchain.chatTrigger');
        if (next.length === 0 && chatUi) continue;
        const guarded = next.some((t) => [IF, SWITCH, FILTER, CODE, STOP].includes(t.type));
        if (!guarded) out.push({ node: n.name, message: `agent has ${(m.incoming.get(n.name) ?? []).filter((e) => e.kind === 'ai_tool').length} tool(s) and its output goes straight to ${next.map((t) => `"${t.name}"`).join(', ') || 'nothing'}` });
      }
      return out;
    },
  },
  {
    id: 'dead-end-branch',
    severity: 'warn',
    title: 'IF / Switch branch drops items on the floor',
    why: 'Items that take an unconnected branch simply vanish. When a filter stops matching because a field was renamed upstream, the write never runs and the execution is still green. Nobody is told.',
    fix: 'Connect every branch. The "nothing matched" branch should at least reach a NoOp you can see in the execution, and in production an IF on item count that raises Stop and Error when zero rows reached the write.',
    ref: 'https://community.n8n.io/t/how-do-you-catch-workflows-that-run-fine-but-do-nothing/308708',
    check(m) {
      const out = [];
      for (const n of m.nodes) {
        if (n.disabled) continue;
        if (n.type === IF) {
          for (const [i, label] of [[0, 'true'], [1, 'false']]) {
            if (m.mainOut(n.name, i).length === 0) out.push({ node: n.name, message: `${label} branch is not connected` });
          }
        } else if (n.type === SWITCH) {
          const outputs = new Set(m.mainOutAll(n.name).map((e) => e.index));
          const rules = n.parameters?.rules?.values ?? n.parameters?.rules?.rules ?? [];
          const count = Array.isArray(rules) && rules.length ? rules.length : 0;
          for (let i = 0; i < count; i++) if (!outputs.has(i)) out.push({ node: n.name, message: `output ${i} is not connected` });
          if (count && n.parameters?.options?.fallbackOutput === undefined) out.push({ node: n.name, message: 'no fallback output: unmatched items are dropped' });
        }
      }
      return out;
    },
  },
  {
    id: 'unasserted-write',
    severity: 'info',
    title: 'Workflow ends on a write with no post-condition',
    why: 'The last node appended a row / sent a message / called POST and the workflow stopped. If that node received zero items, or the API answered 200 with an error body, the run is green and the work did not happen. Run status is not the same thing as "the work got done".',
    fix: 'After the final write, add a small assertion: IF item count > 0 and the response carries an id → done; else Stop and Error with a clear message. Or send a one-line "receipt" (workflow, run id, rows written) to a sheet or log you actually look at.',
    ref: 'https://community.n8n.io/t/my-workflow-ran-700-times-always-green-and-never-did-the-job/310102',
    check(m) {
      return m.nodes.filter((n) => !n.disabled && isWrite(n) && !isNotification(n) && m.isTerminal(n.name))
        .map((n) => ({ node: n.name, message: 'terminal write node; nothing checks what it did' }));
    },
  },
  {
    id: 'code-swallows-error',
    severity: 'warn',
    title: 'Code node catches and discards errors',
    why: 'A try/catch that returns a default instead of rethrowing hides the failure from n8n entirely. It is the JavaScript version of Continue On Fail.',
    fix: 'Inside catch, either `throw` (so the node fails and the error workflow fires) or return an item with an explicit `error` field and route on it in the next node.',
    ref: 'https://community.n8n.io/t/how-do-you-catch-workflows-that-run-fine-but-do-nothing/308708',
    check(m) {
      const out = [];
      for (const n of m.nodes) {
        if (n.type !== CODE || n.disabled) continue;
        const src = String(n.parameters?.jsCode ?? n.parameters?.pythonCode ?? '');
        const re = /catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}/g; // JS
        let match;
        while ((match = re.exec(src))) {
          const body = match[1];
          if (!/\bthrow\b/.test(body) && !/error/i.test(body)) out.push({ node: n.name, message: 'catch block neither throws nor records the error' });
        }
        if (/except\s*(?:Exception|BaseException)?\s*(?:as\s+\w+)?\s*:\s*\n\s*pass\b/.test(src)) out.push({ node: n.name, message: 'except: pass swallows the error' });
      }
      return out;
    },
  },
  {
    id: 'hardcoded-secret',
    severity: 'error',
    title: 'Secret pasted into node parameters',
    why: 'Anything in parameters is exported with the workflow, shows up in execution data, and gets pasted into forum posts. Credentials belong in the credential store.',
    fix: 'Move it to Credentials (Header Auth / Bearer / the service credential) and reference that from the node. Rotate the key that was exposed.',
    ref: 'https://docs.n8n.io/credentials/',
    check(m) {
      const patterns = [
        [/\bsk-[A-Za-z0-9_-]{20,}/, 'OpenAI-style key'],
        [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic key'],
        [/\bxox[abp]-[A-Za-z0-9-]{10,}/, 'Slack token'],
        [/\bAIza[0-9A-Za-z_-]{30,}/, 'Google API key'],
        [/\bghp_[A-Za-z0-9]{30,}/, 'GitHub token'],
        [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
        [/\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'JWT'],
        [/\bBearer\s+(?!\{\{|\$|<|\[|your|YOUR|xxx|\.\.\.)[A-Za-z0-9._-]{24,}/, 'Bearer token'],
        [/\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/, 'Telegram bot token'],
      ];
      const out = [];
      for (const n of m.nodes) {
        walkStrings(n.parameters ?? {}, (s, path) => {
          for (const [re, label] of patterns) if (re.test(s)) { out.push({ node: n.name, message: `${label} in parameters.${path}` }); break; }
        });
      }
      return out;
    },
  },
  {
    id: 'webhook-no-auth',
    severity: 'warn',
    title: 'Webhook accepts unauthenticated calls',
    why: 'An open production webhook is a public API. Anyone who finds the URL can feed the workflow fake events, and with an AI agent behind it, spend your tokens.',
    fix: 'Webhook node → Authentication → Header Auth (a shared secret) or Basic/JWT. For third-party webhooks, verify their signature in the first node after the trigger.',
    ref: 'https://community.n8n.io/t/your-ai-agent-can-drain-your-stripe-account-at-3am-and-n8n-wont-stop-it/313312',
    check(m) {
      return m.nodes.filter((n) => n.type === WEBHOOK && !n.disabled && (n.parameters?.authentication ?? 'none') === 'none')
        .map((n) => ({ node: n.name, message: 'authentication is "none"' }));
    },
  },
  {
    id: 'success-executions-not-saved',
    severity: 'warn',
    title: 'Successful executions are not saved',
    why: 'With saveDataSuccessExecution=none you cannot audit a green run after the fact, so a "ran 700 times and never did the job" pattern is invisible: there is no data to compare durations or item counts against.',
    fix: 'Workflow settings → Save successful executions: Save (with a pruning window via EXECUTIONS_DATA_MAX_AGE) at least for production workflows.',
    ref: 'https://community.n8n.io/t/my-workflow-ran-700-times-always-green-and-never-did-the-job/310102',
    appliesTo: 'settings',
    check(m) {
      const s = m.workflow.settings;
      return s && s.saveDataSuccessExecution === 'none' ? [{ message: 'settings.saveDataSuccessExecution is "none"' }] : [];
    },
  },
  {
    id: 'no-execution-timeout',
    severity: 'info',
    title: 'No workflow-level execution timeout',
    why: 'A stuck execution in queue mode occupies a worker slot until the instance-wide default kicks in. A per-workflow ceiling makes hangs show up as errors instead of as "the queue got slow".',
    fix: 'Workflow settings → Timeout Workflow → a ceiling a little above the slowest expected run.',
    ref: 'https://docs.n8n.io/flow-logic/error-handling/',
    appliesTo: 'settings',
    check(m) {
      const s = m.workflow.settings;
      if (!s) return [];
      if (m.nodes.every((n) => n.type === 'n8n-nodes-base.manualTrigger' || !isTrigger(n))) return [];
      return Number(s.executionTimeout) > 0 ? [] : [{ message: 'settings.executionTimeout not set' }];
    },
  },
  {
    id: 'orphan-node',
    severity: 'warn',
    title: 'Node is not connected to anything',
    why: 'An enabled node with no input and no output never runs. It is either leftover debugging or a step someone believes is happening.',
    fix: 'Connect it or delete it.',
    ref: 'https://docs.n8n.io/workflows/components/nodes/',
    check(m) {
      return m.nodes.filter((n) => !n.disabled && !isTrigger(n) && (m.incoming.get(n.name) ?? []).length === 0 && (m.outgoing.get(n.name) ?? []).length === 0)
        .map((n) => ({ node: n.name, message: 'no connections' }));
    },
  },
  {
    id: 'disabled-node',
    severity: 'info',
    title: 'Disabled node left in the workflow',
    why: 'Disabled nodes pass items through untouched. A disabled validation or dedup step looks like it is protecting you and is not.',
    fix: 'Remove it, or re-enable it before going live.',
    ref: 'https://docs.n8n.io/workflows/components/nodes/',
    check(m) {
      return m.nodes.filter((n) => n.disabled === true).map((n) => ({ node: n.name, message: 'disabled' }));
    },
  },
  {
    id: 'legacy-execution-order',
    severity: 'info',
    title: 'Legacy (v0) execution order',
    why: 'v0 runs branches in an order that surprises people and is no longer the default. Multi-branch workflows behave differently after an import into a fresh instance.',
    fix: 'Workflow settings → Execution Order → v1 (recommended). Re-test branches that depend on ordering.',
    ref: 'https://docs.n8n.io/workflows/settings/',
    appliesTo: 'settings',
    check(m) {
      return m.workflow.settings?.executionOrder === 'v0' ? [{ message: 'settings.executionOrder is "v0"' }] : [];
    },
  },
];
