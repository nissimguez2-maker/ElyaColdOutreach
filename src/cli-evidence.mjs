import { canonical, digest } from './values.mjs';
import { expectedTool, validateCliJob } from './cli-jobs.mjs';

/** Consumes untrusted CLI JSONL in memory. Only fixed projections leave this module. */
export function createEvidenceCollector(input) {
  const job = validateCliJob(input), allowed = expectedTool(job), diagnostics = new Set();
  let bytes = 0, lines = 0, initialized = false, turnCompleted = false, final = null, invalidFinal = false;
  const starts = [], completions = []; let usage = null, previousSummary = null;
  function classifyError(value) {
    const code = value?.code;
    const message = typeof value === 'string' ? value : typeof value?.message === 'string' ? value.message : '';
    if (code === 401 || code === '401' || /\b401\b|unauthorized|token expired|authentication.*expired/i.test(message)) return 'AUTHENTICATION_EXPIRED';
    if (code === 'MCP_TOOL_NOT_FOUND' || code === 'MCP_SERVER_UNAVAILABLE' || /tool not found|connector unavailable|server not found/i.test(message)) return 'CONNECTOR_OR_TOOL_UNAVAILABLE';
    if (code === 403 || code === '403') return 'PERMISSION_OR_ENTITLEMENT_DENIED';
    return 'PROVIDER_ERROR';
  }
  function safeCall(item) {
    let args = item.arguments;
    try { if (typeof args === 'string') args = JSON.parse(args); }
    catch { diagnostics.add('MALFORMED_TOOL_ARGUMENTS'); }
    let matches = false;
    try { matches = item.server === allowed.server && item.tool === allowed.tool && canonical(args) === canonical(allowed.arguments); } catch {}
    if (!matches) diagnostics.add('UNEXPECTED_TOOL_OR_RESOURCE');
    const id = typeof item.id === 'string' && /^[\w-]{1,80}$/.test(item.id) ? item.id : null;
    if (!id) diagnostics.add('MISSING_CALL_ID');
    return { callId: id, expectedCall: matches, status: ['in_progress','completed','failed'].includes(item.status) ? item.status : 'unknown' };
  }
  function projectBody(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    // The read's provider status is not a mailbox or launch decision.
    const id = job.provider === 'apify' ? value.runId : value.id;
    if (id !== job.resourceId) return null;
    if (job.provider === 'apify' && !['READY','RUNNING','TIMING-OUT','TIMED-OUT','ABORTING','ABORTED','SUCCEEDED','FAILED'].includes(value.status)) return null;
    if (job.provider === 'instantly' && !(Number.isSafeInteger(value.status) && value.status >= 0 && value.status <= 100)) return null;
    return { resourceId: id, resourceStatus: String(value.status) };
  }
  function readResponse(item) {
    const result = item.result;
    for (const key of ['isError','is_error']) if (result && Object.hasOwn(result,key) && typeof result[key] !== 'boolean') {
      diagnostics.add('MALFORMED_PROVIDER_ERROR_FLAG'); return { outcome: 'UNRESOLVED', resourceStatus: null };
    }
    if (item.status === 'failed' || item.error || result?.isError === true || result?.is_error === true || result?.structuredContent?.error || result?.structured_content?.error) {
      const category = classifyError(item.error ?? result?.structuredContent?.error ?? result?.structured_content?.error ?? result?.content?.find(c => c.type === 'text')?.text);
      diagnostics.add(category); return { outcome: 'FAILED', errorCategory: category, resourceStatus: null };
    }
    if (!result || typeof result !== 'object' || item.status !== 'completed') return { outcome: 'UNRESOLVED', resourceStatus: null };
    const candidates = [];
    for (const key of ['structuredContent','structured_content']) if (result[key] != null) candidates.push(result[key]);
    if (Array.isArray(result.content)) for (const c of result.content) {
      if (c.type === 'text' && typeof c.text === 'string' && /^\s*\{/.test(c.text)) {
        try { candidates.push(JSON.parse(c.text)); } catch { diagnostics.add('MALFORMED_PROVIDER_JSON'); }
      }
    }
    const projected = candidates.map(projectBody);
    if (!projected.length || projected.some(x => !x)) { diagnostics.add('MISSING_OR_WRONG_PROVIDER_RESOURCE'); return { outcome: 'UNRESOLVED', resourceStatus: null }; }
    if (projected.some(x => canonical(x) !== canonical(projected[0]))) { diagnostics.add('CONFLICTING_PROVIDER_EVIDENCE'); return { outcome: 'UNRESOLVED', resourceStatus: null }; }
    return { outcome: 'SUCCEEDED', ...projected[0] };
  }
  function line(text) {
    try {
      if (typeof text !== 'string') { diagnostics.add('MALFORMED_EVENT'); return; }
      bytes += Buffer.byteLength(text); lines++;
      if (bytes > 2_000_000 || lines > 256 || text.length > 256_000) { diagnostics.add('OUTPUT_LIMIT_EXCEEDED'); return; }
      const event = JSON.parse(text);
      if (!event || typeof event !== 'object') { diagnostics.add('MALFORMED_EVENT'); return; }
      if (event.type === 'turn.started') { if (initialized) diagnostics.add('MULTIPLE_TURNS'); initialized = true; }
      if (event.type === 'turn.completed') {
        turnCompleted = true;
        if (event.usage && typeof event.usage === 'object') usage = Object.fromEntries(Object.entries(event.usage).filter(([k,v]) => ['input_tokens','output_tokens','cached_input_tokens','reasoning_output_tokens'].includes(k) && Number.isSafeInteger(v) && v >= 0));
      }
      if (event.type === 'error' || event.type === 'turn.failed') diagnostics.add(classifyError(event.error ?? event.message));
      const item = event.item;
      if (item?.type === 'mcp_tool_call') {
        if (!initialized || turnCompleted) diagnostics.add('TOOL_OUTSIDE_ACTIVE_TURN');
        const call = safeCall(item);
        if (event.type === 'item.started') {
          if (item.status !== 'in_progress') diagnostics.add('INVALID_TOOL_LIFECYCLE_STATUS');
          starts.push(call);
        }
        else if (event.type === 'item.completed') {
          if (!['completed','failed'].includes(item.status)) diagnostics.add('INVALID_TOOL_LIFECYCLE_STATUS');
          if (!starts.some(start => start.callId === call.callId)) diagnostics.add('COMPLETION_BEFORE_START');
          completions.push({ ...call, ...readResponse(item) });
        }
        else diagnostics.add('UNKNOWN_TOOL_EVENT');
      } else if (item?.type === 'agent_message' && event.type === 'item.completed') {
        try {
          const value = JSON.parse(item.text);
          const keys = ['version','provider','action','resourceId','outcome','resourceStatus'];
          if (!value || Object.keys(value).sort().join() !== keys.sort().join() || value.version !== 1 || value.provider !== job.provider || value.action !== job.action || value.resourceId !== job.resourceId || !['SUCCEEDED','FAILED','BLOCKED'].includes(value.outcome) || !(value.resourceStatus === null || typeof value.resourceStatus === 'string' && value.resourceStatus.length <= 40)) throw new Error();
          // Status must match projected provider evidence, so arbitrary text is never persisted.
          final = { outcome: value.outcome, resourceStatus: value.resourceStatus };
          if (!initialized || turnCompleted || completions.length !== 1) diagnostics.add('SUMMARY_OUTSIDE_COMPLETED_TOOL_TURN');
          if (previousSummary && canonical(previousSummary) !== canonical(final)) diagnostics.add('CONFLICTING_STRUCTURED_SUMMARIES');
          previousSummary = final;
          invalidFinal = false;
        } catch { final = null; invalidFinal = true; }
      } else if (item && !['reasoning','plan'].includes(item.type)) diagnostics.add('UNEXPECTED_EXECUTION_ITEM');
    } catch { diagnostics.add('MALFORMED_EVENT'); }
  }
  function diagnostic(text) {
    // Never retain raw stderr, including token-bearing failures or untrusted messages.
    if (typeof text !== 'string') return;
    if (['PROCESS_START_FAILED','PROCESS_INPUT_CLOSED','OUTPUT_LIMIT_EXCEEDED'].includes(text)) diagnostics.add(text);
    if (/access is denied|EACCES|EPERM|os error 5/i.test(text)) diagnostics.add('LOCAL_ACCESS_DENIED');
    if (/401|unauthorized|token expired/i.test(text)) diagnostics.add('AUTHENTICATION_EXPIRED');
    if (/tool not found|connector unavailable|server not found/i.test(text)) diagnostics.add('CONNECTOR_OR_TOOL_UNAVAILABLE');
  }
  function finish(processResult) {
    const processOutcome = processResult.timedOut ? 'TIMEOUT' : processResult.interrupted ? 'INTERRUPTED' : processResult.exitCode === 0 && !processResult.signal ? 'EXITED_ZERO' : 'EXITED_NONZERO';
    if (processOutcome !== 'EXITED_ZERO') diagnostics.add(processOutcome);
    if (!final) diagnostics.add('MISSING_STRUCTURED_OUTPUT');
    if (invalidFinal) diagnostics.add('INVALID_STRUCTURED_OUTPUT');
    if (!turnCompleted) diagnostics.add('MISSING_TURN_COMPLETION');
    const matched = starts.length === 1 && completions.length === 1 && starts[0].expectedCall && completions[0].expectedCall && starts[0].callId !== null && starts[0].callId === completions[0].callId;
    if (!matched) diagnostics.add('INCOMPLETE_OR_CONFLICTING_TOOL_EVIDENCE');
    const completed = completions[0];
    let readOutcome = 'UNRESOLVED';
    const onlyProviderErrors = [...diagnostics].every(d => ['AUTHENTICATION_EXPIRED','PROVIDER_ERROR','PERMISSION_OR_ENTITLEMENT_DENIED','CONNECTOR_OR_TOOL_UNAVAILABLE'].includes(d));
    if (matched && completed.outcome === 'FAILED' && final && turnCompleted && onlyProviderErrors && processOutcome === 'EXITED_ZERO') readOutcome = 'FAILED';
    else if (matched && completed.outcome === 'SUCCEEDED' && final?.outcome === 'SUCCEEDED' && final.resourceStatus === completed.resourceStatus && diagnostics.size === 0 && processOutcome === 'EXITED_ZERO') readOutcome = 'SUCCEEDED';
    else if (matched && completed.outcome === 'SUCCEEDED' && final && final.resourceStatus !== completed.resourceStatus) diagnostics.add('SUMMARY_EVIDENCE_CONFLICT');
    return {
      version: 1, provider: job.provider, action: job.action, resourceId: job.resourceId,
      processOutcome, readOutcome, exitCode: Number.isSafeInteger(processResult.exitCode) ? processResult.exitCode : null,
      cliInitialized: initialized, modelTurnCompleted: turnCompleted,
      diagnostics: [...diagnostics].sort(), toolEvidence: {
        server: allowed.server, tool: allowed.tool, startedCalls: starts.length, completedCalls: completions.length,
        matched, callIdHash: matched ? digest(completed.callId) : null, providerOutcome: matched ? completed.outcome : 'UNRESOLVED',
        resourceStatus: matched && completed.outcome === 'SUCCEEDED' ? completed.resourceStatus : null
      }, usage, exposedOperationCostUsd: null, billingBasis: 'NOT_EXPOSED; historical run charges are not read-operation costs'
    };
  }
  return { line, diagnostic, finish };
}
