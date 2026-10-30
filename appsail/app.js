import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import catalyst from "zcatalyst-sdk-node";
import { orchestrate, buildMasterPrompt } from "./agents.js";
import { listSessions, createSession, getSession, saveSession, deleteSession } from "./store.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(here, "public")));

// Admin scope: AppSail talks to Stratus and QuickML as the project, not as an end user.
const cat = (req) => catalyst.initialize(req, { scope: "admin" });
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: err.message });
});

const busy = new Set(); // one in-flight turn per session keeps context consistent

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/api/sessions", wrap(async (req, res) => res.json(await listSessions(cat(req)))));

app.post("/api/sessions", wrap(async (req, res) => res.status(201).json(await createSession(cat(req)))));

app.get("/api/sessions/:id", wrap(async (req, res) => {
  const c = cat(req);
  const s = await getSession(c, req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  res.json({ id: s.id, title: s.title, log: s.log });
}));

// Every role's system prompt plus this trip's briefs, as one copyable document.
app.get("/api/sessions/:id/master-prompt", wrap(async (req, res) => {
  const s = await getSession(cat(req), req.params.id);
  if (!s?.context?.trip?.destination) return res.status(404).json({ error: "No trip planned in this session yet" });
  res.type("text/plain").send(buildMasterPrompt(s.context));
}));

app.delete("/api/sessions/:id", wrap(async (req, res) => {
  if (busy.has(req.params.id)) return res.status(409).json({ error: "Session is busy" });
  res.status((await deleteSession(cat(req), req.params.id)) ? 204 : 404).end();
}));

// A chat turn runs as a background job: AppSail caps request time (CATALYST_MAX_TIMEOUT), and a full
// plan can take longer, so POST starts the job and the UI polls /events to watch each agent work.
// shortcut: jobs live in this instance's memory; if AppSail scales to several instances a poll can miss
// the job, and the UI then falls back to reloading the saved session.
const jobs = new Map(); // sessionId → { events: [], done }

app.get("/api/sessions/:id/events", (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.json({ events: [], done: true, missing: true });
  const after = Math.max(0, Number(req.query.after) || 0);
  res.json({ events: job.events.slice(after), done: job.done });
});

app.post("/api/sessions/:id/chat", wrap(async (req, res) => {
  const c = cat(req);
  const s = await getSession(c, req.params.id);
  if (!s) return res.status(404).json({ error: "Session not found" });
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message || message.length > 4000) return res.status(400).json({ error: "message must be 1-4000 chars" });
  if (busy.has(s.id)) return res.status(409).json({ error: "A plan is already running in this session" });

  busy.add(s.id);
  const job = { events: [], done: false };
  jobs.set(s.id, job);
  res.status(202).json({ started: true });
  runTurn(c, s, message, job, { skip: req.body?.skip === true, answer: req.body?.answer === true }).finally(() => {
    job.done = true;
    busy.delete(s.id);
    setTimeout(() => jobs.get(s.id) === job && jobs.delete(s.id), 5 * 60 * 1000);
  });
}));

async function runTurn(c, s, message, job, opts) {
  const send = (event) => job.events.push(event);
  const agents = [];
  try {
    if (s.log.length === 0) s.title = message.slice(0, 60);
    const recent = s.log.slice(-6);
    // Replies to an answer card are kept as answers, shown in the trip brief rather than as chat bubbles.
    s.log.push({ role: "user", text: message, answer: !!opts.answer, at: Date.now() });
    const { reply, ask, profile, plan, context } = await orchestrate(c, s.context, recent, message, (e) => {
      e.at = Date.now(); // lets the UI show per-agent durations, live and on reload
      agents.push(e);
      send(e);
    }, opts);
    s.context = context;
    const t = context.trip || {};
    if (t.destination) s.title = `${t.destination}${t.origin ? ` from ${t.origin}` : ""}${t.start_date ? `, ${t.start_date}` : ""}`;
    s.log.push({ role: "assistant", text: reply, agents, ask, profile, plan, at: Date.now() });
    send({ type: "final", text: reply, ask, profile, plan, title: s.title });
  } catch (err) {
    console.error(err);
    const text = `Error: ${err.message}`;
    s.log.push({ role: "assistant", text, agents, at: Date.now() });
    send({ type: "error", error: text });
  } finally {
    await saveSession(c, s).catch((err) => console.error("saveSession", err));
  }
}

// AppSail injects the port via X_ZOHO_CATALYST_LISTEN_PORT.
const port = process.env.X_ZOHO_CATALYST_LISTEN_PORT || process.env.PORT || 9000;
app.listen(port, () => console.log(`Travel planner on http://localhost:${port}`));
