import test from "node:test";
import assert from "node:assert/strict";
import { conversationRecord, upsertConversationRecord, hydrateConversationRecord, countLabel } from "../reliability/conversation-records.js";
const options = { now: () => 1000, createId: () => "generated-message" };

test("message identity and failed state survive persistence and reload", () => {
  const message = {id:"reply-1", role:"assistant", content:"Partial answer", status:"errored", error:"connection lost", startedAt:10, completedAt:20};
  const record = conversationRecord(message, options);
  const restored = hydrateConversationRecord(JSON.parse(JSON.stringify(record)), 0);
  for (const key of ["id", "role", "content", "status", "error", "startedAt", "completedAt"]) assert.equal(restored[key], message[key]);
});
test("replayed persistence writes keep one message, with the latest content", () => {
  const rows = [];
  const record = conversationRecord({id:"reply-1",role:"assistant",content:"Part",status:"stopped"},options);
  upsertConversationRecord(rows, record);
  upsertConversationRecord(rows, {...record,content:"Part completed",status:"complete"});
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, "Part completed");
});
test("session boundaries prevent cross-thread overwrite", () => {
  const rows=[];
  for (const sessionId of ["a","b"]) upsertConversationRecord(rows, {...conversationRecord({id:"same",role:"user",content:sessionId},options),sessionId});
  assert.equal(rows.length,2);
});
test("legacy messages remain readable without inventing a new timestamp", () => {
  assert.deepEqual(hydrateConversationRecord({role:"user",content:"old",ts:12},3), {role:"user",content:"old",ts:12,id:"hist_3_12",status:"complete",startedAt:12,completedAt:12});
  assert.equal(conversationRecord({role:"user",content:"new"},options).id,"generated-message");
});
test("stopped and empty failed replies preserve their terminal state", () => {
  for (const status of ["stopped","errored"]) assert.equal(hydrateConversationRecord(conversationRecord({role:"assistant",status,content:""},options),0).status,status);
});
test("tool metadata survives reload", () => {
  const toolCalls=[{id:"tool-1",name:"read_subnode",status:"complete"}];
  assert.deepEqual(hydrateConversationRecord(conversationRecord({role:"assistant",toolCalls},options),0).toolCalls,toolCalls);
});
test("memory counts use singular only for one", () => {
  assert.equal(countLabel(0,"decision"),"0 decisions");
  assert.equal(countLabel(1,"decision"),"1 decision");
  assert.equal(countLabel(2,"decision"),"2 decisions");
});

