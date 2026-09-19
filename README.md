# n8n-workflow-lint

Static production-readiness checks for n8n workflow JSON. Point it at an export and it tells
you where the workflow can fail **without anyone finding out**: missing error workflow, HTTP
nodes with no retry or timeout, errors swallowed by *Continue On Fail*, AI Agents whose output is
trusted blindly, IF branches that drop items on the floor, secrets pasted into parameters,
unauthenticated webhooks.

No install, no signup, nothing leaves your machine:

```
npx github:tachyurgy/n8n-workflow-lint my-workflow.json
```

(Zero dependencies, Node 18+. An npm package name is coming; the GitHub form works today.)

```
my-workflow.json  "Inbound lead sync"  score 61/100 (C)  2 error, 4 warn, 1 info
  ERROR no-error-workflow
        settings.errorWorkflow is not set
  ERROR agent-unguarded  @ "Qualify lead"
        agent has 3 tool(s) and its output goes straight to "Update CRM"
  WARN  http-no-retry  @ "Enrich company"
        retryOnFail is off
  WARN  http-no-timeout  @ "Enrich company"
        options.timeout not set
  WARN  dead-end-branch  @ "Is qualified?"
        false branch is not connected
  WARN  webhook-no-auth  @ "Inbound Lead Webhook"
        authentication is "none"
  INFO  unasserted-write  @ "Update CRM"
        terminal write node; nothing checks what it did
```

Every rule exists because of a thread on community.n8n.io where someone lost days to it.
`npx n8n-workflow-lint --rules` prints the why, the fix and the thread for each one.

## Why

The failure that costs the most in production n8n is not the red execution. It is the green
one that did nothing: a token expired, a field got renamed, a filter stopped matching, a tool
inside an agent failed and the model filled the gap with a guess. Every node is green, zero
records landed, and the error workflow never fires because from n8n's point of view nothing went
wrong. By the time someone notices it has been broken for days.

Most of the ways that happens are visible in the workflow JSON *before* it runs. This linter
looks for them.

## What it found on the 400 most-viewed public templates

I ran it over the 400 most-viewed workflows on n8n.io/workflows (September 2026):

| | |
|---|---|
| HTTP Request nodes | **628** — 20 (3%) have Retry On Fail, 8 (1%) have a timeout |
| Webhook triggers | **67** — 2 use any authentication |
| Templates that ship settings | **205** — 142 (69%) have no error workflow |
| AI Agent nodes | **248** — 67 templates use an agent's output with no guard after it |
| IF / Switch with an unconnected branch | **22%** of templates |
| Nodes set to Continue On Fail with nothing checking the error | **8%** of templates |

Templates are starting points, not production, so none of this is a criticism of their authors.
It is a measure of how much hardening sits between "it works in the editor" and "it runs for a
client for a year".

## Rules

| id | severity | catches |
|---|---|---|
| `no-error-workflow` | error | No Error Workflow attached: failures are recorded and nobody is told |
| `swallowed-error` | error | *Continue (regular output)* with no downstream check, or *Continue (error output)* with the error output unconnected |
| `agent-unguarded` | error | AI Agent with tools whose output flows onward with no Code/IF/Stop guard and no error branch |
| `hardcoded-secret` | error | OpenAI / Anthropic / Slack / Google / GitHub / AWS keys, JWTs, bearer tokens in parameters |
| `http-no-retry` | warn | HTTP Request without Retry On Fail |
| `http-no-timeout` | warn | HTTP Request without Options → Timeout |
| `dead-end-branch` | warn | IF true/false or Switch output not connected; Switch without fallback |
| `code-swallows-error` | warn | Code node `catch {}` that neither throws nor records; Python `except: pass` |
| `webhook-no-auth` | warn | Webhook trigger with Authentication = none |
| `success-executions-not-saved` | warn | `saveDataSuccessExecution: none` — you cannot audit a green run later |
| `orphan-node` | warn | Enabled node with no connections at all |
| `unasserted-write` | info | Workflow ends on a data write and nothing checks the item count or the response |
| `no-execution-timeout` | info | No per-workflow timeout |
| `disabled-node` | info | Disabled node still in the workflow |
| `legacy-execution-order` | info | `executionOrder: v0` |

Score starts at 100; errors cost 12, warnings 5, info 1, with repeated hits of the same rule
discounted so twenty un-retried HTTP nodes read as one problem, not twenty.

## Usage

```
n8n-workflow-lint <file.json|dir> [...]     lint one or more exports (dirs are scanned for *.json)
n8n-workflow-lint --rules                    list rules with the failure each one prevents
cat workflow.json | n8n-workflow-lint -      read from stdin

--json               machine-readable output
--min-score <n>      exit 1 if any workflow scores below n
--fail-on <level>    exit 1 if any finding is at or above error|warn|info (default: error)
--only <ids>         comma-separated rule ids to run
--ignore <ids>       comma-separated rule ids to skip
--quiet              one summary line per workflow
```

It accepts a single workflow export, an array of them, or the `{ "workflow": {...} }` shape the
public template API returns.

### In CI

If you version your workflows in git (you should; there is a template for backing them up to
GitHub), gate merges on them:

```yaml
- run: npx github:tachyurgy/n8n-workflow-lint workflows/ --fail-on warn --min-score 75
```

### As a library

```js
import { lint } from 'n8n-workflow-lint';
const { score, grade, findings } = lint(JSON.parse(fs.readFileSync('wf.json', 'utf8')));
```

## What it does not do

It is static. It reads the JSON you export and nothing else, so it cannot tell you a workflow
*is* failing silently; it tells you where it *can*. Pair it with an execution-side check for the runtime half: the
[Production Hardening Kit](https://github.com/tachyurgy/n8n-automation-portfolio/tree/main/04-production-hardening-kit)
is four importable workflows (deduped error router, outcome assertion sub-workflow, hourly
execution auditor, worked example) that do exactly that. Workflow-level rules (`no-error-workflow`,
`no-execution-timeout`, …) are skipped when an export has no `settings` block, which is the
case for most template downloads.

Rules are heuristics. `unasserted-write` and `agent-unguarded` in particular are opinions about
how production workflows should end; disagree with `--ignore`.

## Contributing

Rules live in `src/rules/index.js`, one object each with `check(model)` returning findings.
`src/model.js` builds the small graph the rules query. `npm test` runs the fixtures; every rule
must fire on `test/fixtures/bad.json` and stay silent on `test/fixtures/good.json`.

If a rule fires on a workflow where the pattern is deliberate, open an issue with the export.
The goal is that every finding is something a senior engineer would actually flag in review.

## Author

Built by [Levelbrook Consulting](https://automation.levelbrook.com/engineering/), a senior
software engineer who builds n8n and Make automations that hold up in production, and the custom
code around them when the node palette runs out. MIT licensed.
