import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, stripThinking } from "../llm.js";

test("extractJson handles fences, prose and think blocks", () => {
  const raw = '<think>plan the budget</think>Sure:\n```json\n{"action":"plan","run":["flights"]}\n```';
  assert.deepEqual(extractJson(stripThinking(raw)), { action: "plan", run: ["flights"] });
  assert.throws(() => extractJson("no json here"), /No JSON/);
});
