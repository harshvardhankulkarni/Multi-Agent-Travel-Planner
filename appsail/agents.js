// Multi-agent travel adviser on Catalyst QuickML LLM Serving.
// The endpoint has no tool calling, so the flow is code-driven:
//   1. Intake: an extractor LLM pulls only what the user explicitly said into the trip profile;
//      code then asks the next unanswered question, one at a time, as an answer card in the UI.
//   2. Planning: Transport, Stay, Activity and Local-expert agents run in parallel on the full profile,
//      overspenders are re-briefed once, and the Orchestrator writes the advice.
import { chat, chatJson } from "./llm.js";

const AGENTS = ["transport", "stays", "activities", "local"];
const PRICED = ["transport", "stays", "activities"]; // agents that get a share of the budget
const LABELS = { transport: "Transport agent", stays: "Stay agent", activities: "Activity agent", local: "Local expert", composer: "Orchestrator" };
const today = () => new Date().toISOString().slice(0, 10);
const NONE = "none"; // an optional question the user chose to skip

// ---------- Intake: one question at a time ----------

const where = (t) => t.destination || "there";

// Ordered; required ones come first. `missing(trip)` decides whether to ask; `q` may depend on what we know.
// `type` tells the UI which answer card to show: text, dates, budget or choice (with `multi` for several picks).
const SLOTS = [
  { key: "destination", label: "Destination", required: true, type: "text", missing: (t) => !t.destination,
    q: () => "Where would you like to go?", placeholder: "City, region or country" },
  { key: "origin", label: "Starting from", required: true, type: "text", missing: (t) => !t.origin,
    q: () => "Which city will you be starting from?", placeholder: "Your home city" },
  { key: "dates", label: "Dates", required: true, type: "dates", missing: (t) => !t.start_date || !t.end_date,
    q: (t) => (t.start_date ? "When do you come back?" : "When are you travelling?") },
  {
    key: "travelers", label: "Travellers", required: true, missing: (t) => !t.travelers || !t.companions,
    type: (t) => (t.companions ? "text" : "choice"),
    q: (t) => (t.companions ? "How many people in total, including you?" : "Who's coming along?"),
    choices: (t) => (t.companions ? [] : ["Just me", "Me and my partner", "Family with kids", "Group of friends", "Colleagues"]),
    placeholder: (t) => (t.companions ? "e.g. 4" : "Or describe your group"),
  },
  {
    key: "budget", label: "Budget", required: true, missing: (t) => !t.budget || !t.currency || !t.budget_basis,
    type: (t) => (t.budget && t.currency ? "choice" : t.budget ? "choice" : "budget"),
    q: (t) => (t.budget && t.currency ? `Is ${Number(t.budget).toLocaleString()} ${t.currency} per person or for the whole group?`
      : t.budget ? "Which currency is that budget in?" : "What's your budget for the trip?"),
    choices: (t) => (t.budget && t.currency ? ["Per person", "For the whole group"] : t.budget ? ["INR", "USD", "EUR", "GBP", "AED"] : []),
  },
  { key: "mode", label: "Getting there", type: "choice", multi: true, missing: (t) => !t.mode,
    q: () => "How would you like to travel there and back?", choices: () => ["Flight", "Train", "Bus", "Drive", "Suggest the best option"],
    placeholder: "e.g. train there, flight back" },
  { key: "visited", label: "Been before", type: "choice", missing: (t) => !t.visited,
    q: (t) => `Have you been to ${where(t)} before?`, choices: () => ["First time", "Been before"],
    placeholder: "e.g. been 4 times, always to the usual spots" },
  { key: "seen_places", label: "Already seen", type: "text",
    missing: (t) => t.visited === "been_before" && !t.seen_places,
    q: (t) => `Which places in ${where(t)} have you already seen? I'll suggest fresh ones instead.`,
    placeholder: "e.g. Baga, Calangute, Fort Aguada, Anjuna flea market" },
  { key: "bookings", label: "Already booked", type: "choice", missing: (t) => !t.bookings,
    q: () => "Have you already booked anything, like tickets or a stay?", choices: () => ["Nothing booked yet"],
    placeholder: "Share what's booked: train, flight, hotel, times" },
  { key: "occasion", label: "Occasion", type: "choice", missing: (t) => !t.occasion,
    q: () => "Is this trip for a special occasion?", choices: () => ["Just a holiday", "Honeymoon", "Anniversary", "Birthday", "Bachelor party", "Work trip"] },
  { key: "interests", label: "Interests", type: "choice", multi: true, missing: (t) => !t.interests,
    q: () => "What do you enjoy on a trip? Pick as many as you like.",
    choices: () => ["Beaches", "Sightseeing", "Nightlife and parties", "Food trails", "Adventure and water sports", "Markets and shopping", "Culture and history", "Nature", "Relaxing"],
    placeholder: "e.g. sightseeing by day, nightlife at night, relaxed pace" },
  { key: "food", label: "Food", type: "choice", multi: true, missing: (t) => !t.food,
    q: () => "Any food preferences or allergies?", choices: () => ["Vegetarian", "Non-vegetarian", "Seafood lovers", "Vegan", "Jain", "No restrictions"],
    placeholder: "Allergies or dishes to avoid" },
  { key: "drinks", label: "Drinks", type: "choice", missing: (t) => !t.drinks,
    q: () => "Do you drink? It helps me suggest local drinks, bars and breweries, or leave them out.",
    choices: () => ["Yes, love trying local drinks", "Occasionally", "Some of us do", "Non-drinkers"] },
  { key: "stay_pref", label: "Stay", type: "choice", multi: true, missing: (t) => !t.stay_pref,
    q: () => "What kind of place do you like to stay in?",
    choices: () => ["Budget hotel", "Hostel", "Villa or apartment", "Boutique or heritage", "Beach resort", "Homestay", "No preference"] },
  { key: "platforms", label: "Booking platforms", type: "choice", multi: true, missing: (t) => !t.platforms,
    q: () => "Do you prefer booking through any platform, or have a membership I should use?",
    choices: () => ["Airbnb", "Booking.com", "MakeMyTrip", "Agoda", "Goibibo", "No preference"],
    placeholder: "Memberships, e.g. Booking Genius, Marriott Bonvoy, MMT Black" },
  { key: "special", label: "Also noted", type: "text", missing: (t) => !t.special,
    q: () => "Anything else I should know? Rules for the trip, accessibility needs, things to avoid.",
    placeholder: "e.g. no early mornings, max 2 sights a day, avoid crowds", choices: () => ["Nothing else"] },
];

const val = (v, t) => (typeof v === "function" ? v(t) : v);
function askFor(slot, trip) {
  return {
    key: slot.key, label: slot.label, question: slot.q(trip), type: val(slot.type, trip) || "text",
    options: slot.choices?.(trip) || [], multi: !!slot.multi, optional: !slot.required,
    placeholder: val(slot.placeholder, trip) || "",
  };
}

// Total trip budget for the whole party, whatever way the user expressed it.
export const totalBudget = (t) => (t.budget_basis === "per_person" ? Number(t.budget) * (Number(t.travelers) || 1) : Number(t.budget));

// What we know so far, as label/value rows for the UI's trip-brief card.
function profile(t) {
  const shown = (v) => (v === NONE ? "No preference" : v);
  const money = (n) => Number(n).toLocaleString();
  const budget = t.budget && `${money(t.budget)} ${t.currency || ""}${t.budget_basis === "per_person"
    ? ` per person${t.travelers ? `, ${money(totalBudget(t))} in total` : ""}` : t.budget_basis === "total" ? " in total" : ""}`;
  const rows = [
    ["Destination", t.destination], ["Starting from", t.origin],
    ["Dates", t.start_date && `${t.start_date}${t.end_date ? ` to ${t.end_date}` : ""}`],
    ["Travellers", t.travelers && `${t.travelers}${t.companions ? ` (${t.companions})` : ""}`],
    ["Budget", budget?.trim()], ["Getting there", t.mode],
    ["Been before", t.visited && (t.visited === "been_before" ? "Yes" : t.visited === "first_time" ? "First time" : t.visited)],
    ["Already seen", t.seen_places], ["Already booked", t.bookings === NONE ? "Nothing yet" : t.bookings], ["Occasion", t.occasion],
    ["Interests", t.interests], ["Food", t.food], ["Drinks", t.drinks], ["Stay", t.stay_pref], ["Booking platforms", t.platforms],
    ["Also noted", t.special === NONE ? "Nothing else" : t.special],
    ["Your rules", t.rules?.length ? t.rules.join("; ") : null],
  ];
  return rows.filter(([, v]) => v).map(([label, v]) => ({ label, value: String(shown(v)) }));
}

const FIELDS = ["destination", "origin", "start_date", "end_date", "travelers", "companions", "budget", "currency", "budget_basis",
  "mode", "visited", "seen_places", "bookings", "occasion", "interests", "food", "drinks", "stay_pref", "platforms", "special"];

const EXTRACT_SYSTEM = `You are the intake step of an expert travel adviser. Today is ${today()}.
You receive the traveller profile collected so far, the question that was just asked, and the user's new message.

Return only one JSON object:
{"updates": {<only fields the user explicitly stated in THIS message>},
 "new_rules": [string],
 "intent": "answer" | "question" | "change" | "plan_now",
 "reply": string,
 "run": ["transport" | "stays" | "activities" | "local"]}

Profile fields: destination, origin, start_date (YYYY-MM-DD), end_date (YYYY-MM-DD), travelers (number of people),
companions (solo, partner, family with kids, friends, colleagues…), budget (number), currency (ISO code like INR),
budget_basis ("per_person" or "total"), mode (keep their own words when they add detail, e.g. "train there, flight back";
"best" if they ask you to choose), visited ("first_time" or "been_before"), seen_places (places they have already visited there,
comma separated), bookings, occasion, interests, food, drinks, stay_pref, platforms (booking sites and memberships), special.

Rules:
- Never guess or infer a value the user did not state. If unsure, leave the field out.
- "Just me" means travelers 1 and companions "solo". "Me and my partner" means travelers 2 and companions "partner".
- A date without a year means its next occurrence after today. "5 days from 12 Dec" sets both start_date and end_date.
  A season, festival or month alone ("Christmas season", "in May") is not a date: set no dates for it.
- Budget: "₹50k" or "50000 rupees" means budget 50000 and currency INR. "per head", "per person", "each" means budget_basis
  "per_person"; "total", "overall", "for all of us", "for the whole group" means "total". "5 to 6k per head" means budget 6000, per_person.
  If they do not say which, leave budget_basis out.
- "Been before", "visited 4 times" means visited "been_before"; "first time" means "first_time". Any places they say they
  have seen go into seen_places.
- Answers to multi-choice questions may list several picks ("Sightseeing and Nightlife, relaxed pace"): keep them all, as one string.
- "new_rules" holds explicit do or don't instructions the user wants applied to the whole trip, in their words, e.g.
  "no early mornings", "max 2 sights a day", "avoid crowded places", "always vegetarian", "no clubs". Facts that belong in
  profile fields (budget, travel mode, origin, interests, preferences) are never rules. Otherwise [].
- "Just a holiday" is an answer (occasion "holiday"), not a skip.
- If the user skips the current question ("skip", "no preference", "nothing", "not sure", "nothing booked") set that field to "none",
  but never for destination, origin, dates, travelers or budget.
- intent "plan_now" only when the user explicitly says to stop asking and plan ("just plan it", "skip the rest") or confirms
  the summary ("plan my trip", "yes, go ahead"). A message that merely describes the trip ("plan a trip to X…") is "answer".
  "question" when they ask for advice or information; "change" when they change something about a plan that already exists,
  including "we've already been to X" or "replace X"; otherwise "answer".
- For "question", write "reply" as an expert travel adviser: specific, practical, 2-5 sentences. Otherwise "reply" is "".
- For "change", list in "run" the agents whose part of the plan must be redone (transport: getting there and back,
  stays: where to stay, activities: days, sights, restaurants, local: local specialities, drinks, events, offbeat picks).`;

function validate(updates, trip) {
  const u = {};
  for (const k of FIELDS) if (updates?.[k] !== undefined && updates[k] !== null && updates[k] !== "") u[k] = updates[k];
  const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d));
  for (const k of ["start_date", "end_date"]) if (u[k] && (!isDate(u[k]) || u[k] < today())) delete u[k];
  const start = u.start_date || trip.start_date, end = u.end_date || trip.end_date;
  if (start && end && end < start) delete u.end_date;
  if (u.budget !== undefined && !(Number(u.budget) > 0)) delete u.budget;
  if (u.travelers !== undefined && !(Number.isInteger(Number(u.travelers)) && Number(u.travelers) >= 1)) delete u.travelers;
  for (const k of ["destination", "origin", "start_date", "end_date", "travelers", "budget", "currency", "companions", "budget_basis"]) if (u[k] === NONE) delete u[k];
  if (u.budget_basis && !["per_person", "total"].includes(u.budget_basis)) delete u.budget_basis;
  if (u.visited && u.visited !== NONE && !["first_time", "been_before"].includes(u.visited)) u.visited = /first/i.test(u.visited) ? "first_time" : "been_before";
  if (u.budget) u.budget = Number(u.budget);
  if (u.travelers) u.travelers = Number(u.travelers);
  if (u.currency) u.currency = String(u.currency).toUpperCase();
  // Places already seen accumulate across the conversation instead of being replaced.
  if (u.seen_places && u.seen_places !== NONE && trip.seen_places && trip.seen_places !== NONE) {
    const all = new Map([...String(trip.seen_places).split(","), ...String(u.seen_places).split(",")]
      .map((p) => p.trim()).filter(Boolean).map((p) => [p.toLowerCase(), p]));
    u.seen_places = [...all.values()].join(", ");
  }
  return u;
}

// A real day ("20 Dec", "Dec 20", "2026-12-20", "20/12"), not just any number like "6 people".
export const looksLikeDate = (text) =>
  /\b\d{1,2}(st|nd|rd|th)?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s*\d{1,2}\b|\d{4}-\d{2}-\d{2}|\b\d{1,2}[/.]\d{1,2}\b/i.test(text);

const nextSlot = (trip) => SLOTS.find((s) => s.missing(trip));
const missingRequired = (trip) => SLOTS.some((s) => s.required && s.missing(trip));

// ---------- Specialist agents ----------

const COMMON = `You are part of an expert travel-advice team. You have no live booking data: give realistic estimates from typical
prices for the season, name real operators, trains, neighbourhoods, hotels, venues, restaurants and bars, and put assumptions in caveats.
All costs are totals for the whole party in the trip currency. Personalise everything to the traveller profile: who is travelling,
the occasion, interests, food and drink preferences, booking platforms, special needs and anything already booked.
The traveller's "rules" are hard constraints: never break them. Never send them to places listed in "seen_places"; suggest
fresher alternatives instead. Stay within your allocated budget; if that is impossible say so plainly in summary, give the
cheapest realistic option, and say what it would really cost. Reply with only one JSON object, no prose, in exactly this shape:`;

const SPECIALISTS = {
  transport: `You are the Transport agent. Plan how the traveller gets from origin to destination and back, by their chosen mode
(if mode is "best" or "none", choose the best mode for time and budget and say why). Break each direction into legs.
For flights and trains include the airport or station transfer. For driving give the road route, drive time, fuel and toll
estimate, and good rest or food stops; there is no airport or station in a road trip. If tickets are already booked, use those
and only fill the gaps.
${COMMON}
{"summary": string, "mode": "flight" | "train" | "bus" | "car" | "mixed",
 "outbound": [{"from": string, "to": string, "mode": string, "service": string, "depart": "HH:MM", "arrive": "HH:MM", "duration": string, "est_cost": number, "notes": string}],
 "return": [same shape as outbound],
 "route_via": string (main towns or highways on the way), "distance": string, "drive_or_travel_time": string,
 "fuel_tolls": number (driving only, else 0),
 "local_transport": string,
 "est_total": number, "tips": [string], "caveats": [string]}`,
  stays: `You are the Stay agent. Recommend exactly 3 real places to stay that fit the stay preference, the group and the occasion.
For groups, say how many rooms or which villa size, and prefer villas or apartments when they are better value for the group.
Use the traveller's preferred booking platforms: say where each option is best booked ("platform") and mention membership perks.
Every option's est_total must fit within your allocated budget; offer a range (best value, a step up, a treat) inside that limit.
If a stay is already booked, put it first and suggest 2 alternatives anyway.
${COMMON}
{"summary": string,
 "options": [{"name": string, "area": string, "type": string, "rooms": string, "platform": string, "why": string, "est_per_night": number, "est_total": number}],
 "recommended": number (index into options), "est_total": number (the recommended option's total), "tips": [string], "caveats": [string]}`,
  activities: `You are the Activity agent. Plan each day from arrival to departure with timed items at real, named places.
Day 1 starts with arrival by the traveller's own mode of travel and the last day ends with their departure; leave time for both.
Match the interests (for example beaches by day and nightlife at night) and the pace. Respect drink preferences: include bars,
breweries or beach shacks only if they drink, and nothing alcohol-centred for non-drinkers. If they have been before, prefer
offbeat places over the usual tourist list and never repeat seen_places. Do not plan intercity travel or accommodation.
"food" lists named restaurants, shacks or cafes (not dish names) that match their food preferences.
${COMMON}
{"summary": string,
 "days": [{"day": number, "date": "YYYY-MM-DD", "title": string, "items": [{"time": "HH:MM", "place": string, "what": string, "est_cost": number}]}],
 "food": [{"name": string, "area": string, "try": string, "why": string}],
 "special": string,
 "est_total": number, "tips": [string], "caveats": [string]}`,
  local: `You are the Local expert: a well-travelled insider for the destination. Tell the traveller what the place is famous for
and what they must not miss in their season and dates, tuned to their interests, group and occasion: signature dishes and where to
eat them, local drinks and the best places to try them (only if they drink; return [] for drinks otherwise), festivals or events
during their dates, and offbeat hidden gems. If they have been before, every hidden gem must replace a typical tourist spot,
especially their seen_places. Suggest add-ons that would make the trip better. Judge the budget honestly for this group, season
and destination, and list what to cut first if money gets tight and how much each cut saves.
Reply with only one JSON object, no prose, in exactly this shape:
{"summary": string,
 "famous_for": [{"title": string, "detail": string}],
 "signature_food": [{"dish": string, "where": string}],
 "drinks": [{"name": string, "where": string, "note": string}],
 "events": [{"name": string, "when": string, "where": string}],
 "hidden_gems": [{"place": string, "instead_of": string, "why": string}],
 "add_ons": [{"title": string, "why": string, "est_cost": number}],
 "areas": [{"name": string, "why": string}] (2-3 best areas to base themselves for this group and these interests),
 "realistic_budget": {"low": number, "high": number} (total for the whole party, trip currency, for this season),
 "budget_check": string,
 "skip_if_tight": [{"item": string, "saves": number}],
 "tips": [string]}`,
};

function headline(kind, r) {
  if (kind === "transport") return [r.mode, r.outbound?.[0]?.service].filter(Boolean).join(": ");
  if (kind === "stays") return r.options?.[r.recommended ?? 0]?.name;
  if (kind === "local") return r.famous_for?.slice(0, 3).map((f) => f.title).join(", ");
  return r.days?.length ? `${r.days.length} days planned` : undefined;
}

function runSpecialist(app, kind, brief) {
  return chatJson(app, [
    { role: "system", content: SPECIALISTS[kind] },
    { role: "user", content: `Brief from the orchestrator:\n${JSON.stringify(brief)}` },
  ]);
}

const seenList = (trip) => String(trip.seen_places && trip.seen_places !== NONE ? trip.seen_places : "")
  .split(",").map((p) => p.trim().toLowerCase().replace(/(beach|fort|market|flea)/g, "").trim()).filter((p) => p.length > 2);
const isSeen = (text, seen) => seen.find((p) => String(text || "").toLowerCase().includes(p));

// Last line of defence: drop anything at a place the traveller has already been, wherever an agent slipped it in.
export function scrubSeen(results, trip) {
  const seen = seenList(trip);
  if (!seen.length) return results;
  const a = results.activities, x = results.local;
  if (a?.days) for (const d of a.days) d.items = (d.items || []).filter((i) => !isSeen(i.place, seen));
  if (a?.food) a.food = a.food.filter((f) => !isSeen(`${f.name} ${f.area}`, seen));
  if (x) for (const k of ["drinks", "signature_food"]) if (Array.isArray(x[k])) x[k] = x[k].filter((v) => !isSeen(v.where, seen));
  if (x?.hidden_gems) x.hidden_gems = x.hidden_gems.filter((g) => !isSeen(g.place, seen));
  return results;
}

// Hard checks on a day plan: no places the traveller has already seen, nothing earlier than their rules allow.
export function violations(kind, out, trip) {
  // A single category costing the whole trip budget is a misread of the brief, not an estimate.
  const total = totalBudget(trip);
  if (PRICED.includes(kind) && total > 0 && Number(out?.est_total) >= total) {
    return [`est_total ${out.est_total} equals or exceeds the whole trip budget ${total}; give only the cost of your own part.`];
  }
  if (kind !== "activities" || !Array.isArray(out?.days)) return [];
  const seen = seenList(trip);
  const rules = (trip.rules || []).join(" ").toLowerCase();
  const m = rules.match(/before\s+(\d{1,2})\s*(am)?/);
  const earliest = m ? Number(m[1]) : /early morning/.test(rules) ? 9 : null;
  const found = [];
  for (const d of out.days) for (const i of d.items || []) {
    const place = String(i.place || "").toLowerCase();
    const hit = isSeen(place, seen);
    if (hit) found.push(`Day ${d.day}: "${i.place}" is somewhere they have already been (${hit}).`);
    const h = Number(String(i.time || "").split(":")[0]);
    if (earliest !== null && d.day !== 1 && d.day !== out.days.length && h < earliest) found.push(`Day ${d.day}: ${i.time} breaks their rule about early mornings.`);
  }
  return found;
}

// Deterministic split of the total budget; ~10% stays unallocated as a buffer for food and local transport.
function allocate(trip) {
  const m = String(trip.mode).toLowerCase();
  const shares = m.includes("flight") ? [0.35, 0.33, 0.22] : m.includes("train") ? [0.15, 0.45, 0.30]
    : m.includes("bus") ? [0.12, 0.46, 0.32] : /car|drive/.test(m) ? [0.18, 0.42, 0.30] : [0.28, 0.38, 0.24];
  const total = totalBudget(trip);
  return Object.fromEntries(PRICED.map((k, i) => [k, Math.round(total * shares[i])]));
}

// The LLM endpoint rejects long prompts (MORE_THAN_MAX_LENGTH), so the composer gets only what it writes about.
const PROMPT_MAX = Number(process.env.LLM_PROMPT_MAX || 9000);
function forComposer(results, level = 0) {
  const cut = (s, n) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);
  const few = (a, n) => (Array.isArray(a) ? a.slice(0, level ? Math.max(1, n - level) : n) : undefined);
  const tips = (a) => few(a, 3)?.map((x) => cut(x, 120));
  const leg = (l) => ({ from: l.from, to: l.to, mode: l.mode, service: l.service, depart: l.depart, arrive: l.arrive, cost: l.est_cost });
  const { transport: t, stays: s, activities: a, local: x } = results;
  return {
    transport: t && { summary: cut(t.summary, 200), mode: t.mode, via: cut(t.route_via, 120), distance: t.distance, time: t.drive_or_travel_time, fuel_tolls: t.fuel_tolls, outbound: t.outbound?.map(leg), return: t.return?.map(leg), local: cut(t.local_transport, 140), est_total: t.est_total, tips: tips(t.tips) },
    stays: s && { recommended: s.recommended, est_total: s.est_total, tips: tips(s.tips),
      options: s.options?.slice(0, 3).map((o) => ({ name: o.name, area: o.area, type: o.type, rooms: o.rooms, platform: o.platform, why: cut(o.why, level ? 80 : 150), total: o.est_total })) },
    activities: a && { est_total: a.est_total, special: cut(a.special, 160),
      days: a.days?.map((d) => ({ day: d.day, date: d.date, title: d.title,
        items: d.items?.slice(0, level > 1 ? 4 : 7).map((i) => `${i.time || ""} ${i.place || ""}${level > 1 ? "" : `: ${cut(i.what, level ? 40 : 70)}`}`.trim()) })),
      food: few(a.food, 5)?.map((f) => ({ name: f.name, area: f.area, try: cut(f.try, 50) })) },
    local: x && {
      famous_for: few(x.famous_for, 5)?.map((f) => `${f.title}: ${cut(f.detail, level ? 50 : 90)}`),
      signature_food: few(x.signature_food, 4)?.map((f) => `${f.dish} at ${f.where}`),
      drinks: few(x.drinks, 3)?.map((d) => `${d.name} at ${d.where}`),
      events: few(x.events, 3)?.map((e) => `${e.name}, ${e.when}, ${e.where}`),
      hidden_gems: few(x.hidden_gems, 4)?.map((g) => `${g.place} instead of ${g.instead_of}`),
      add_ons: few(x.add_ons, 3)?.map((o) => `${o.title} (${o.est_cost})`),
      areas: few(x.areas, 3)?.map((a) => `${a.name}: ${cut(a.why, 70)}`),
      realistic_budget: x.realistic_budget,
      budget_check: cut(x.budget_check, 200),
      skip_if_tight: few(x.skip_if_tight, 4)?.map((k) => `${k.item} saves ${k.saves}`),
    },
  };
}

// If the Local expert says the budget is clearly too low, offer realistic per-person levels to choose from.
export function budgetFollowUp(trip, results) {
  const total = totalBudget(trip), n = Number(trip.travelers) || 1;
  const low = Number(results.local?.realistic_budget?.low), high = Number(results.local?.realistic_budget?.high);
  if (!(total > 0) || !(low > total * 1.15)) return null;
  const pp = Math.round(total / n), step = (v) => Math.round(v / 500) * 500;
  const lowPp = step(low / n), highPp = step((high > low ? high : low * 1.25) / n);
  const fmt = (v) => `${Number(v).toLocaleString("en-IN")} ${trip.currency || ""}`.trim();
  const mid = step((pp + lowPp) / 2);
  const options = [`Keep ${fmt(pp)} per person, strictly`];
  if (mid > pp && mid < lowPp) options.push(`${fmt(mid)} per person`);
  options.push(`${fmt(lowPp)} per person`, `${fmt(lowPp)} to ${fmt(highPp)} per person, comfortable`);
  return { key: "budget_flex", label: "Budget flexibility", type: "choice", options,
    question: `Your budget is tight for this trip. Realistically it needs about ${fmt(lowPp)} to ${fmt(highPp)} per person. How flexible is it?`,
    placeholder: "Or type your own per-person budget" };
}

// ---------- Orchestrator ----------

const COMPOSER_SYSTEM = `You are a senior travel adviser writing the main body of a trip plan from your team's results, in Markdown.
The app already shows, above your text, the trip title, photos, dates, the profile you used and a budget-reality card,
and below your text, booking links, maps, photos and a calendar export. Do not repeat those; never write URLs.
Write in the first person ("I'd choose…"), warm and direct, short sentences, concrete names, times and prices in the trip currency.
Respect the traveller's rules and never send them to places in seen_places. Use only what the agents returned.
Use exactly these sections:
## 1. Where to stay
One sentence naming the best area, then a table | Area | Why stay there | from the areas, then the three options as a numbered
list "**Name**: Best value (or Best balance, or Treat), type, area, about X total", one label per option. Add one line if prices are estimates, not live availability.
## 2. Getting there: {origin} to {destination}
Bullets: recommended route (via towns), distance, travel time, fuel and tolls or fares. Then a table | Date | Plan | with departure
and arrival on both travel days.
## 3. Your day-by-day itinerary
For each day "### Day N" then a bold one-line theme with the date, then a table | Time | Activity |. Mention optional events in one line.
## 4. Food, drinks and nightlife
For each place: "**Name**" on one line, then "Area · Type" and what to try. Local drinks only if they drink.
## 5. Fresh experiences
Only if they have been before or there are offbeat picks: "**Place**: one line why", noting what it replaces.
## 6. Budget breakdown
A table | Category | Estimated | Your allocation | with rows Transport, Stay, Activities and nightlife, Food and local transport,
and a bold Total. Then the estimated cost per person. If the estimate is above their budget, add "### If you must stay within X"
with 4-5 concrete compromises.
## 7. Booking and travel tips
4-6 bullets: booking timing, what to confirm with the host, safety (never drink and drive), what to carry.
## My final recommendation
Two or three sentences with your clear recommendation. End with one line: prices are estimates, not live quotes.`;

/**
 * Run one user turn. `context` is the session memory ({ trip, pending, planned, allocation, results })
 * and is returned updated. Returns { reply, ask?, profile?, plan?, context }.
 */
export async function orchestrate(app, context, recent, userText, emit, { skip = false } = {}) {
  context.trip ??= {};
  const trip = context.trip;
  const pendingSlot = SLOTS.find((s) => s.key === context.pending);

  // Skip button: no need to ask the LLM what the user meant.
  let ex = { updates: {}, new_rules: [], intent: "answer", reply: "", run: [] };
  if (skip && pendingSlot && !pendingSlot.required) trip[pendingSlot.key] = NONE;
  else {
    ex = await chatJson(app, [
      { role: "system", content: EXTRACT_SYSTEM },
      {
        role: "user",
        content: `Profile so far:\n${JSON.stringify(trip)}\n\nQuestion just asked: ${context.pendingQuestion || "(none)"}\n` +
          `Plan already made: ${context.planned ? "yes" : "no"}\n\n` +
          `Recent chat:\n${recent.map((m) => `${m.role}: ${m.text.slice(0, 300)}`).join("\n") || "(none)"}\n\nNew message:\n${userText}`,
      },
    ]);
  }
  const updates = validate(ex.updates, trip);
  for (const k of Object.keys(updates)) if (String(updates[k]).toLowerCase() === String(trip[k] ?? "").toLowerCase()) delete updates[k];
  // Dates need a real day: "Christmas season" or "in May" must not become exact dates.
  if ((updates.start_date || updates.end_date) && context.pending !== "dates" && !looksLikeDate(userText)) { delete updates.start_date; delete updates.end_date; }
  // "Been before" is never assumed: accept it only from its own question or when the user talks about past visits.
  // Free-text notes only come from their own question; the extractor likes to stuff other answers into it.
  if (updates.special && context.pending !== "special") delete updates.special;
  if (updates.visited && context.pending !== "visited" && !/before|visited|been|first (time|trip)|times/i.test(userText)) delete updates.visited;
  // An optional question answered in free text counts as answered, even if the extractor filed it elsewhere (e.g. as a rule).
  if (pendingSlot && !pendingSlot.required && !skip && ex.intent !== "question" && pendingSlot.missing({ ...trip, ...updates }) && userText.trim()) {
    updates[pendingSlot.key] = pendingSlot.key === "visited"
      ? (/first|never|\bno\b/i.test(userText) ? "first_time" : "been_before") : userText.trim();
  }
  Object.assign(trip, updates);
  // Rules the user sets stay in the trip profile for every later turn and every agent.
  const facts = /budget|per head|per person|travel+ing (from|by)|by (car|train|flight|bus)|from \w+ by/i;
  const newRules = (Array.isArray(ex.new_rules) ? ex.new_rules : []).map((r) => String(r).trim()).filter((r) => r && !facts.test(r))
    .filter((r) => !(trip.rules || []).some((x) => x.toLowerCase() === r.toLowerCase()));
  if (newRules.length) trip.rules = [...(trip.rules || []), ...newRules];

  // Opening messages often say "plan a trip…"; that is not permission to skip the questions.
  const intent = ex.intent === "plan_now" && !context.pending && !context.planned ? "answer" : ex.intent;

  // Advice questions get an expert answer in the chat; intake then carries on with the next question.
  const answer = intent === "question" && ex.reply ? String(ex.reply).trim() : "";

  if (intent === "plan_now" && !missingRequired(trip)) {
    for (const s of SLOTS) if (!s.required && s.missing(trip)) trip[s.key] = NONE;
  }

  const ask = (a) => {
    context.pending = a.key;
    context.pendingQuestion = a.question;
    return { reply: answer, ask: a, profile: profile(trip), context };
  };

  // Still collecting: ask exactly one thing, as an answer card in the UI.
  const slot = nextSlot(trip);
  if (slot) return ask(askFor(slot, trip));

  // Everything known but not yet planned: confirm before spending the team's time.
  if (!context.planned && intent !== "plan_now") {
    const changing = context.pending === "confirm" && Object.keys(updates).length === 0 && !newRules.length && !answer;
    return ask(changing
      ? { key: "change", label: "Change", question: "What would you like to change?", type: "text", options: [], placeholder: "e.g. make it 5 days, or add my parents" }
      : { key: "confirm", label: "Ready", question: "That's everything I need. Shall I plan your trip?", type: "choice", options: ["Plan my trip", "Change something"] });
  }
  if (context.planned && !Object.keys(updates).length && !newRules.length && intent !== "change") {
    context.pending = null; context.pendingQuestion = null;
    return { reply: answer || "Got it, I'll keep the plan as it is. Ask me to change anything: dates, stay, places or budget.", context };
  }

  // ---------- Plan (or re-plan the affected parts) ----------
  context.pending = null;
  context.pendingQuestion = null;
  let run = AGENTS;
  if (context.planned) {
    const touched = new Set((Array.isArray(ex.run) ? ex.run : []).filter((a) => AGENTS.includes(a)));
    const changed = Object.keys(updates);
    const hits = (keys) => changed.some((k) => keys.includes(k));
    if (hits(["origin", "destination", "start_date", "end_date", "travelers", "mode", "budget", "currency", "budget_basis", "bookings"])) touched.add("transport");
    if (hits(["destination", "start_date", "end_date", "travelers", "budget", "currency", "budget_basis", "stay_pref", "platforms", "occasion", "special", "bookings"])) touched.add("stays");
    if (hits(["destination", "start_date", "end_date", "budget", "currency", "budget_basis", "interests", "food", "drinks", "occasion", "special", "seen_places", "visited"])) touched.add("activities");
    if (hits(["destination", "start_date", "end_date", "interests", "food", "drinks", "seen_places", "visited", "budget", "budget_basis", "occasion"])) touched.add("local");
    if (newRules.length) AGENTS.forEach((a) => touched.add(a));
    run = touched.size ? AGENTS.filter((a) => touched.has(a)) : AGENTS;
  }
  context.allocation = allocate(trip);
  context.results ??= {};
  const fresh = {};
  const request = context.planned ? userText : "";
  const tripForAgents = { ...trip, total_budget: totalBudget(trip) };

  const dispatch = async (kind, extraNote = "") => {
    const brief = {
      traveller_profile: tripForAgents, allocated_budget: context.allocation[kind],
      latest_request: [request, extraNote].filter(Boolean).join(" "),
    };
    emit({ type: "agent_start", agent: kind, label: LABELS[kind], input: context.allocation[kind] ? { budget: context.allocation[kind] } : undefined });
    try {
      const out = await runSpecialist(app, kind, brief);
      out.headline = headline(kind, out);
      // A re-brief only replaces the first answer if it is actually better.
      const prev = extraNote && fresh[kind];
      const score = (r) => violations(kind, r, trip).length * 1e9 + Math.max(0, (r.est_total || 0) - (context.allocation[kind] || Infinity));
      if (prev && score(out) > score(prev)) {
        emit({ type: "agent_done", agent: kind, label: LABELS[kind], result: { summary: "Kept the first plan; the revision was no better.", est_total: prev.est_total, headline: prev.headline } });
        return;
      }
      fresh[kind] = out;
      emit({ type: "agent_done", agent: kind, label: LABELS[kind], result: { summary: out.summary, est_total: out.est_total, headline: out.headline } });
    } catch (err) {
      emit({ type: "agent_error", agent: kind, label: LABELS[kind], error: err.message });
    }
  };

  await Promise.all(run.map((k) => dispatch(k)));
  // Re-brief once: overspending, or breaking the traveller's rules and seen places.
  const notes = {};
  for (const k of run) {
    if (!fresh[k]) continue;
    const n = violations(k, fresh[k], trip);
    if (context.allocation[k] && fresh[k].est_total > context.allocation[k] * 1.1) n.push(`Your estimate ${fresh[k].est_total} exceeded your allocation ${context.allocation[k]}. Find cheaper options within it.`);
    if (n.length) notes[k] = `Fix these problems in your previous answer: ${n.slice(0, 8).join(" ")}`;
  }
  await Promise.all(Object.entries(notes).map(([k, note]) => dispatch(k, note)));

  Object.assign(context.results, scrubSeen(fresh, trip));
  if (!PRICED.some((k) => context.results[k])) {
    return { reply: "The team couldn't build a plan this time.", ask: { key: "confirm", label: "Retry", question: "Try planning again?", type: "choice", options: ["Plan my trip"] }, context };
  }

  emit({ type: "agent_start", agent: "composer", label: LABELS.composer });
  let input;
  for (let level = 0; level < 4; level++) {
    input = JSON.stringify({
      traveller_profile: tripForAgents, allocation: context.allocation, change_request: request || undefined,
      results: forComposer(context.results, level), failed_agents: run.filter((k) => !fresh[k]),
    });
    if (COMPOSER_SYSTEM.length + input.length <= PROMPT_MAX) break;
  }
  const reply = await chat(app, [{ role: "system", content: COMPOSER_SYSTEM }, { role: "user", content: input }]);
  emit({ type: "agent_done", agent: "composer", label: LABELS.composer });
  context.planned = true;

  const follow = budgetFollowUp(trip, context.results);
  if (follow) { context.pending = follow.key; context.pendingQuestion = follow.question; }
  return { reply, plan: { trip: tripForAgents, ...context.results }, ask: follow || undefined, profile: profile(trip), context };
}

/**
 * One self-contained "master prompt" for a planned trip: every role's system prompt, the brief each
 * specialist receives, and the run order, so the whole team can be reproduced in any LLM.
 */
export function buildMasterPrompt(context) {
  const trip = { ...(context.trip || {}), total_budget: totalBudget(context.trip || {}) };
  const allocation = context.allocation || allocate(trip);
  const brief = (kind) => JSON.stringify({ traveller_profile: trip, allocated_budget: allocation[kind], latest_request: "" }, null, 2);
  const block = (text) => "```text\n" + text.trim() + "\n```";
  const json = (obj) => "```json\n" + (typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)) + "\n```";
  const roles = [
    ["Transport agent", "transport", "Plans the journey there and back, leg by leg, by the traveller's chosen mode."],
    ["Stay agent", "stays", "Recommends three places to stay inside the stay budget, with where to book them."],
    ["Activity agent", "activities", "Builds the timed day-by-day plan and named places to eat and drink."],
    ["Local expert", "local", "Adds what the destination is famous for, local food and drinks, events, fresh picks, add-ons and a budget check."],
  ];
  return [
    `# Master prompt: ${trip.destination || "trip"} from ${trip.origin || "?"}, ${trip.start_date || "?"} to ${trip.end_date || "?"}`,
    "",
    "## Your role",
    "You are the Orchestrator of a multi-agent travel advisory team. You run each specialist below with its own system prompt and brief,",
    "check their answers against the traveller's budget, rules and already-visited places, and then write the final plan as the expert adviser.",
    "",
    "## How to run the team",
    "1. Intake: collect the traveller profile one question at a time with the Intake agent until every field is answered or skipped.",
    "2. Run the Transport, Stay, Activity and Local expert agents in parallel, each with its system prompt and its brief.",
    "3. Check each answer: costs within the allocated budget (10% tolerance), no places listed in seen_places, no rule broken.",
    "   Re-brief an agent once with the exact problems if it fails, and keep whichever answer is better.",
    "4. Write the final plan with the Orchestrator prompt, using only what the agents returned.",
    "",
    "## Traveller profile",
    json(trip),
    trip.rules?.length ? `\n## Traveller rules (hard constraints for every agent)\n${trip.rules.map((r) => `- ${r}`).join("\n")}\n` : "",
    "## Budget allocation (whole party, " + (trip.currency || "") + ")",
    json(allocation),
    "",
    "## Role 1: Intake agent",
    "Turns each traveller message into profile updates. It never guesses, and the next unanswered question is asked one at a time.",
    "### System prompt",
    block(EXTRACT_SYSTEM),
    ...roles.flatMap(([name, key, what], i) => [
      "", `## Role ${i + 2}: ${name}`, what,
      "### System prompt", block(SPECIALISTS[key]),
      "### Brief (user message)", "Brief from the orchestrator:", json(brief(key)),
    ]),
    "", `## Role ${roles.length + 2}: Orchestrator (final write-up)`,
    "Merges the four agents' JSON into the traveller-facing plan.",
    "### System prompt", block(COMPOSER_SYSTEM),
    "### Input (user message)",
    "A JSON object with traveller_profile, allocation and results { transport, stays, activities, local } holding each agent's reply.",
  ].join("\n");
}
