const terminalStates = new Set(["complete", "stopped", "errored"]);

export function conversationRecord(message, { now = Date.now, createId = () => crypto.randomUUID() } = {}) {
  const ts = Number.isFinite(message.startedAt) ? message.startedAt : Number.isFinite(message.ts) ? message.ts : now();
  const record = {
    id: message.id || createId(), role: message.role, content: message.content || "", ts,
    status: terminalStates.has(message.status) ? message.status : "complete",
    startedAt: ts,
    completedAt: Number.isFinite(message.completedAt) ? message.completedAt : now(),
  };
  if (message.error) record.error = String(message.error);
  if (Array.isArray(message.toolCalls) && message.toolCalls.length) record.toolCalls = message.toolCalls;
  return record;
}

// A repeated persistence call for the same message must not append another row.
// Sessions are part of the key so replay cannot overwrite a different thread.
export function upsertConversationRecord(records, record) {
  const index = records.findIndex((item) => item.id === record.id && item.sessionId === record.sessionId);
  if (index < 0) records.push(record);
  else records[index] = { ...records[index], ...record };
  return record;
}

export function hydrateConversationRecord(record, index) {
  return {
    ...record,
    id: record.id || `hist_${index}_${record.ts || 0}`,
    status: terminalStates.has(record.status) ? record.status : "complete",
    startedAt: record.startedAt ?? record.ts ?? 0,
    completedAt: record.completedAt ?? record.ts ?? 0,
  };
}

export function countLabel(count, singular, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}
