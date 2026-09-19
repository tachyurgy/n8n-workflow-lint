// A small graph model over an n8n workflow export so rules can ask simple questions
// ("what feeds this node?", "is output 1 of this IF connected?") without re-parsing.

const TRIGGER_TYPES = new Set([
  'n8n-nodes-base.webhook',
  'n8n-nodes-base.manualTrigger',
  'n8n-nodes-base.scheduleTrigger',
  'n8n-nodes-base.cron',
  'n8n-nodes-base.interval',
  'n8n-nodes-base.errorTrigger',
  'n8n-nodes-base.formTrigger',
  'n8n-nodes-base.executeWorkflowTrigger',
  'n8n-nodes-base.start',
  'n8n-nodes-base.n8nTrigger',
  'n8n-nodes-base.workflowTrigger',
  '@n8n/n8n-nodes-langchain.chatTrigger',
  '@n8n/n8n-nodes-langchain.mcpTrigger',
]);

export const NON_EXECUTING_TYPES = new Set(['n8n-nodes-base.stickyNote']);

// Node types whose only job is to flow data onward; a workflow that *ends* on one of
// these has not written anything, so the "unasserted write" rule ignores them.
const PASSTHROUGH_TYPES = new Set([
  'n8n-nodes-base.set', 'n8n-nodes-base.noOp', 'n8n-nodes-base.code', 'n8n-nodes-base.if',
  'n8n-nodes-base.switch', 'n8n-nodes-base.filter', 'n8n-nodes-base.merge',
  'n8n-nodes-base.splitInBatches', 'n8n-nodes-base.splitOut', 'n8n-nodes-base.aggregate',
  'n8n-nodes-base.itemLists', 'n8n-nodes-base.sort', 'n8n-nodes-base.limit',
  'n8n-nodes-base.removeDuplicates', 'n8n-nodes-base.wait', 'n8n-nodes-base.function',
  'n8n-nodes-base.functionItem', 'n8n-nodes-base.dateTime', 'n8n-nodes-base.crypto',
  'n8n-nodes-base.renameKeys', 'n8n-nodes-base.compareDatasets', 'n8n-nodes-base.summarize',
  'n8n-nodes-base.extractFromFile', 'n8n-nodes-base.convertToFile', 'n8n-nodes-base.html',
  'n8n-nodes-base.markdown', 'n8n-nodes-base.xml', 'n8n-nodes-base.editImage',
  'n8n-nodes-base.compression', 'n8n-nodes-base.stopAndError', 'n8n-nodes-base.respondToWebhook',
  'n8n-nodes-base.executeWorkflow', 'n8n-nodes-base.debugHelper', 'n8n-nodes-base.form',
  '@n8n/n8n-nodes-langchain.agent', '@n8n/n8n-nodes-langchain.chainLlm',
  '@n8n/n8n-nodes-langchain.chainSummarization', '@n8n/n8n-nodes-langchain.informationExtractor',
  '@n8n/n8n-nodes-langchain.textClassifier', '@n8n/n8n-nodes-langchain.sentimentAnalysis',
  '@n8n/n8n-nodes-langchain.openAi', '@n8n/n8n-nodes-langchain.chainRetrievalQa',
]);

const WRITE_OPERATIONS = new Set([
  'create', 'append', 'appendOrUpdate', 'insert', 'update', 'upsert', 'delete', 'send',
  'post', 'sendMessage', 'sendEmail', 'publish', 'write', 'push', 'execute', 'executeQuery',
  'move', 'copy', 'add', 'remove', 'set', 'invite', 'archive', 'edit', 'reply',
]);
const WRITE_HTTP = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function isTrigger(node) {
  return TRIGGER_TYPES.has(node.type) || /trigger$/i.test(node.type);
}

// Best-effort: does this node change state somewhere outside n8n?
export function isWrite(node) {
  if (node.type === 'n8n-nodes-base.httpRequest') {
    const m = String(node.parameters?.method ?? 'GET').toUpperCase();
    return WRITE_HTTP.has(m);
  }
  if (node.type === 'n8n-nodes-base.postgres' || node.type === 'n8n-nodes-base.mySql' ||
      node.type === 'n8n-nodes-base.microsoftSql' || node.type === 'n8n-nodes-base.supabase') {
    const op = node.parameters?.operation;
    return op === undefined || WRITE_OPERATIONS.has(op) || op === 'executeQuery';
  }
  if (PASSTHROUGH_TYPES.has(node.type) || isTrigger(node)) return false;
  const op = node.parameters?.operation;
  if (typeof op === 'string' && WRITE_OPERATIONS.has(op)) return true;
  // Messaging nodes default to "send" when operation is omitted.
  if (/slack|gmail|telegram|discord|twilio|emailSend|sendGrid|mailgun|whatsApp|microsoftTeams|mattermost/i.test(node.type) && op === undefined) return true;
  return false;
}

// Notification nodes are their own receipt: a Slack message that went out IS the evidence.
// The unasserted-write rule is about data writes whose success you cannot see.
export function isNotification(node) {
  return /slack|gmail|telegram|discord|twilio|emailSend|sendGrid|mailgun|whatsApp|microsoftTeams|mattermost|pushover|pushbullet|signl4|pagerDuty|opsgenie|sms/i.test(node.type);
}

export function buildModel(workflow) {
  const nodes = (workflow.nodes ?? []).filter((n) => !NON_EXECUTING_TYPES.has(n.type));
  const byName = new Map(nodes.map((n) => [n.name, n]));
  const outgoing = new Map(); // name -> [{ kind:'main'|'ai_tool'..., index, to, toInput }]
  const incoming = new Map(); // name -> [{ kind, index, from }]
  for (const n of nodes) { outgoing.set(n.name, []); incoming.set(n.name, []); }
  for (const [from, kinds] of Object.entries(workflow.connections ?? {})) {
    for (const [kind, outputs] of Object.entries(kinds ?? {})) {
      (outputs ?? []).forEach((edges, index) => {
        for (const e of edges ?? []) {
          if (!byName.has(from) || !byName.has(e.node)) continue;
          outgoing.get(from).push({ kind, index, to: e.node, toInput: e.index ?? 0 });
          incoming.get(e.node).push({ kind, index, from, toKind: e.type ?? kind });
        }
      });
    }
  }
  const mainOut = (name, index) => (outgoing.get(name) ?? []).filter((e) => e.kind === 'main' && e.index === index);
  const mainOutAll = (name) => (outgoing.get(name) ?? []).filter((e) => e.kind === 'main');
  const mainIn = (name) => (incoming.get(name) ?? []).filter((e) => e.kind === 'main');
  const isTerminal = (name) => mainOutAll(name).length === 0;
  return { workflow, nodes, byName, outgoing, incoming, mainOut, mainOutAll, mainIn, isTerminal };
}
