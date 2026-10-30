import { test } from "node:test";
import assert from "node:assert/strict";
import { totalBudget } from "../agents.js";

test("per-person budgets are multiplied by the party size", () => {
  assert.equal(totalBudget({ budget: 6000, budget_basis: "per_person", travelers: 6 }), 36000);
  assert.equal(totalBudget({ budget: 70000, budget_basis: "total", travelers: 2 }), 70000);
});

import { violations } from "../agents.js";
test("day plans may not revisit seen places or break early-morning rules", () => {
  const trip = { seen_places: "Baga, Fort Aguada", rules: ["nothing before 10am"] };
  const days = [{ day: 1, items: [] }, { day: 2, items: [{ time: "08:30", place: "Divar Island" }, { time: "21:00", place: "Tito's Lane (Baga)" }] }, { day: 3, items: [] }];
  const v = violations("activities", { days }, trip);
  assert.equal(v.length, 2);
  assert.deepEqual(violations("stays", { days }, trip), []);
});

import { scrubSeen } from "../agents.js";
test("seen places are scrubbed from days and local picks", () => {
  const r = scrubSeen({
    activities: { days: [{ day: 1, items: [{ place: "Tito's Lane (Baga)" }, { place: "Divar Island" }] }], food: [] },
    local: { drinks: [{ name: "Feni", where: "Britto's, Baga" }], hidden_gems: [] },
  }, { seen_places: "Baga" });
  assert.deepEqual(r.activities.days[0].items.map((i) => i.place), ["Divar Island"]);
  assert.equal(r.local.drinks.length, 0);
});

import { budgetFollowUp } from "../agents.js";
test("a clearly unrealistic budget triggers a flexibility question", () => {
  const trip = { budget: 6000, budget_basis: "per_person", travelers: 6, currency: "INR" };
  const ask = budgetFollowUp(trip, { local: { realistic_budget: { low: 65000, high: 85000 } } });
  assert.equal(ask.key, "budget_flex");
  assert.match(ask.options[0], /Keep 6,000 INR per person/);
  assert.equal(budgetFollowUp(trip, { local: { realistic_budget: { low: 38000, high: 45000 } } }), null);
});

import { looksLikeDate } from "../agents.js";
test("only real days count as dates", () => {
  for (const t of ["20 Dec for 4 days", "From 2026-12-25 to 2026-12-29", "dec 20", "25/12"]) assert.ok(looksLikeDate(t), t);
  for (const t of ["christmas season, 5 to 6k per head, 6 people", "in May"]) assert.ok(!looksLikeDate(t), t);
});
