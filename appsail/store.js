// Session store on Catalyst Stratus (object storage).
//   sessions/<id>.json  → { id, title, createdAt, updatedAt, context, log }
//   sessions/index.json → { <id>: { title, updatedAt } }  (one read to list the sidebar)
// Each session's own `context` object is what keeps its conversation memory separate.
// shortcut: index.json is read-modify-write, so two sessions saving at the same instant can drop
// an index entry; fine for a single-team demo, move to Data Store once billing is enabled.
import crypto from "node:crypto";

const BUCKET = process.env.STRATUS_BUCKET || "travel-planner-sessions-60057482421";
const INDEX = "sessions/index.json";
const isId = (id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id); // UUIDs only; keeps keys inside sessions/
const keyOf = (id) => `sessions/${id}.json`;

const bucket = (app) => app.stratus().bucket(BUCKET);

async function readJson(app, key) {
  let stream;
  try {
    stream = await bucket(app).getObject(key);
  } catch (err) {
    if (/not.?found|404|no_such_key|does not exist/i.test(String(err?.message ?? err))) return null;
    throw err;
  }
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

const writeJson = (app, key, value) =>
  bucket(app).putObject(key, JSON.stringify(value), { overwrite: true, contentType: "application/json" });

async function updateIndex(app, fn) {
  const index = (await readJson(app, INDEX)) || {};
  fn(index);
  await writeJson(app, INDEX, index);
}

export async function listSessions(app) {
  const index = (await readJson(app, INDEX)) || {};
  return Object.entries(index)
    .map(([id, v]) => ({ id, title: v.title, updatedAt: v.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function createSession(app) {
  const now = Date.now();
  const s = { id: crypto.randomUUID(), title: "New trip", createdAt: now, updatedAt: now, context: {}, log: [] };
  await saveSession(app, s);
  return { id: s.id, title: s.title, updatedAt: s.updatedAt };
}

export const getSession = (app, id) => (isId(id) ? readJson(app, keyOf(id)) : null);

export async function saveSession(app, s) {
  s.updatedAt = Date.now();
  await writeJson(app, keyOf(s.id), s);
  await updateIndex(app, (index) => { index[s.id] = { title: s.title, updatedAt: s.updatedAt }; });
}

export async function deleteSession(app, id) {
  if (!isId(id) || !(await getSession(app, id))) return false;
  await bucket(app).deleteObject(keyOf(id));
  await updateIndex(app, (index) => { delete index[id]; });
  return true;
}
