# Multi-Agent Travel Planner

A chat-based travel adviser where a team of AI agents plans a trip together. You describe the trip; the orchestrator asks what it still needs, one question at a time; then five specialists build the plan in parallel and the orchestrator writes it up as one expert itinerary.

Everything runs on [Zoho Catalyst](https://catalyst.zoho.com): AppSail hosts the app, QuickML LLM Serving (GLM-4.7-Flash) is the model, and Stratus stores the chat sessions.

## What it does

- **Asks, never guesses.** Destination, starting city, dates, travellers, budget (per person or whole group), travel mode, past visits, bookings, occasion, interests, food, drinks, stay type, booking platforms and any rules. Each question appears as an answer card with choices, multi-select, date pickers or a budget field, and anything you already said is skipped.
- **Plans with a team of agents**, shown live as they work:

  | Agent | Job |
  |---|---|
  | Orchestrator | Runs intake, briefs the team, checks results, writes the final plan |
  | Transport agent | Route there and back, leg by leg (flight, train, bus or road trip) |
  | Stay agent | Three places to stay within the stay budget, with where to book |
  | Activity agent | Timed day-by-day plan, named restaurants and nightlife |
  | Local expert | What the place is famous for, local food and drinks, events, offbeat picks, budget reality check |

- **Keeps you honest on budget.** Each agent gets a share of the budget; overspenders are re-briefed once. If the budget is unrealistic, the plan says so and asks how flexible you are.
- **Remembers your rules and history.** Rules like "nothing before 10am" and places you have already visited are enforced in code, not just requested from the model.
- **Rich plan view.** Budget tiles, route map, photo collage, stay cards with Booking.com, Google Hotels and Airbnb links, place photos, an `.ics` calendar export with reminders, **Copy plan**, and **Copy master prompt** (every agent's system prompt and brief for the trip).
- **Sessions.** Each chat keeps its own context; history lives in the sidebar.

## How it works

```
Browser (public/index.html)
   │  POST /api/sessions/:id/chat   → starts a background job, returns 202
   │  GET  /api/sessions/:id/events → polled every second for agent progress
   ▼
AppSail: Express (app.js)
   ├── agents.js  intake → Transport, Stay, Activity, Local expert in parallel → checks → Orchestrator write-up
   ├── llm.js     QuickML LLM Serving endpoint (prompt in, text out)
   └── store.js   one JSON file per session in a Stratus bucket
```

The LLM endpoint has no tool calling and caps prompts at about 10,000 characters, so the orchestration is code-driven and the write-up input is trimmed to fit. AppSail caps request time, so each chat turn runs as a background job that the browser polls.

## Project layout

| Path | What it is |
|---|---|
| `appsail/app.js` | Express server, session routes, background jobs, master-prompt route |
| `appsail/agents.js` | Intake questions, agent prompts, budget split, rule checks, orchestration |
| `appsail/llm.js` | QuickML LLM client and JSON extraction |
| `appsail/store.js` | Session storage on Stratus |
| `appsail/public/index.html` | The whole UI (no build step) |
| `appsail/test/` | `node --test` tests |
| `appsail/app-config.json` | AppSail runtime config and non-secret environment variables |
| `catalyst.json`, `.catalystrc` | Catalyst CLI project files (generated) |

## Setup

Prerequisites: Node.js 24 and the Catalyst CLI (`npm i -g zcatalyst-cli`, then `catalyst login`).

1. **Link the project:** `catalyst init --org <orgId> -p <projectId> -ni`
2. **LLM endpoint:** in the Catalyst console, open QuickML → LLM Serving, create a GLM-4.7-Flash configuration (conversation mode off, max tokens 4096, temperature about 0.3), save it and publish it as an endpoint.
3. **Stratus bucket:** in Cloud Scale → Stratus, click Start Exploring and create a bucket with the Authenticated template.
4. **Environment variables** for the AppSail service:

   | Variable | Purpose |
   |---|---|
   | `QUICKML_LLM_ENDPOINT` | Endpoint name from its URL, e.g. `glm-flash-47` |
   | `QUICKML_LLM_ENDPOINT_KEY` | The endpoint key. **Secret:** set it in Console → AppSail → Environment Variables, not in `app-config.json` |
   | `QUICKML_ORG_ID` | Your Catalyst org ID |
   | `STRATUS_BUCKET` | The bucket name from step 3 |
   | `LLM_PROMPT_MAX` | Optional, default `9000` characters |

   Names starting with `CATALYST` are reserved by AppSail and rejected on deploy.
5. **Install:** `cd appsail && npm install`

## Run, test, deploy

```bash
# local: proxies Stratus and QuickML calls to the Development environment
catalyst serve --only appsail

# tests
cd appsail && npm test

# deploy to Development
catalyst deploy --only appsail -ni
```

## MCP

`.mcp.json` registers the Catalyst MCP server for Claude Code. Its URL contains an auth token, so the file is git-ignored; keep it that way.

## Limits

- Prices, routes, events and venues come from the model, not live booking data. Treat them as estimates and check before booking.
- Place photos come from Wikipedia's public API in the browser, so some places have no photo or a loose match.
- Background jobs live in one AppSail instance's memory. If the service scales out, a poll can miss its job; the UI then reloads the saved session.
- The Stratus session index is read-modify-write, so two sessions saving at the same instant can drop a sidebar entry (the session itself is kept).
- There is no login yet: anyone with the URL can see and delete every trip. Enable Catalyst Authentication before sharing it.
