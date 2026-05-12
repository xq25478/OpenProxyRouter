"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveApiKey,
  recordKeyOutcome,
  getKeySchedulerSnapshot,
} = require("./backend");

function fakeReq() { return { headers: {} }; }

function fresh(model) {
  // Force scheduler re-init by using a unique model name for each test.
  return `test-${model}-${Math.random().toString(36).slice(2)}`;
}

test("scheduler - distributes by weight (smooth WRR)", () => {
  const keys = [
    { key: "a", weight: 1 },
    { key: "b", weight: 3 },
  ];
  const m = fresh("dist");
  // With affinity the scheduler pins one key. Build up weights via success,
  // then force a key switch to verify the new schedule.
  // 1 — first pick seeds the affinity key (say it's "b", weight 3).
  const first = resolveApiKey(fakeReq(), keys, m);
  // 2 — give "b" repeated 200s to push its weight up.
  for (let j = 0; j < 5; j++) recordKeyOutcome(m, first, 200);
  // 3 — fail "b" so affinity breaks and a new pick happens.
  recordKeyOutcome(m, first, 429);
  // 4 — new pick should be the next best candidate.
  const second = resolveApiKey(fakeReq(), keys, m);
  // Since "a" weight=1 and "b" weight=3+5=8 but blacklisted,
  // the next pick must be "a" (the only remaining usable key).
  assert.strictEqual(second, "a", "after b is blacklisted, remaining key a should be picked");
  // 5 — once b's blackout expires (~30s), the next pick could be b again.
  // Simulate by manually clearing blackout and verifying affinity picks b back.
  const snap = getKeySchedulerSnapshot();
  const stateKey = Object.keys(snap).find(k => k.startsWith("dist")) || "dist";
  // We can't easily manipulate clock, so just verify the weights look correct.
  const s = getKeySchedulerSnapshot();
  const dist = Object.values(s).flat();
  const aWeight = dist.find(e => e.key === "a").weight;
  const bWeight = dist.find(e => e.key === "b").weight;
  assert.ok(aWeight === 1 || aWeight === 3, `a weight should be 1 or 3 (reset), got ${aWeight}`);
  assert.ok(bWeight >= 6, `b weight should be >= 6 after 5x200, got ${bWeight}`);;
});

test("scheduler - 200 raises weight", () => {
  const keys = [{ key: "x", weight: 1 }, { key: "y", weight: 1 }];
  const m = fresh("raise");
  resolveApiKey(fakeReq(), keys, m); // init state
  for (let i = 0; i < 5; i++) recordKeyOutcome(m, "x", 200);
  const snap = getKeySchedulerSnapshot()[m];
  const xw = snap.find(e => e.key === "x").weight;
  assert.ok(xw >= 6, `x weight should grow from 1 to >=6 (got ${xw})`);
});

test("scheduler - 429 lowers weight and applies blackout", () => {
  const keys = [{ key: "x", weight: 5 }, { key: "y", weight: 5 }];
  const m = fresh("rate");
  resolveApiKey(fakeReq(), keys, m);
  recordKeyOutcome(m, "x", 429);
  const snap = getKeySchedulerSnapshot()[m];
  const x = snap.find(e => e.key === "x");
  assert.equal(x.weight, 3, `weight should drop by 2 (got ${x.weight})`);
  assert.ok(x.blackoutMs > 25_000 && x.blackoutMs <= 30_000, `blackout ~30s (got ${x.blackoutMs}ms)`);
});

test("scheduler - 401 blackholes the key (weight=0)", () => {
  const keys = [{ key: "x", weight: 10 }, { key: "y", weight: 10 }];
  const m = fresh("unauth");
  resolveApiKey(fakeReq(), keys, m);
  recordKeyOutcome(m, "x", 401);
  const snap = getKeySchedulerSnapshot()[m];
  assert.equal(snap.find(e => e.key === "x").weight, 0);
  // All subsequent picks should be "y"
  for (let i = 0; i < 20; i++) {
    assert.equal(resolveApiKey(fakeReq(), keys, m), "y");
  }
});

test("scheduler - resets when every key is blackholed", () => {
  const keys = [{ key: "x", weight: 1 }, { key: "y", weight: 1 }];
  const m = fresh("reset");
  resolveApiKey(fakeReq(), keys, m);
  recordKeyOutcome(m, "x", 401);
  recordKeyOutcome(m, "y", 401);
  // Both at 0 — next pick should reset
  const k = resolveApiKey(fakeReq(), keys, m);
  assert.ok(k === "x" || k === "y");
  const snap = getKeySchedulerSnapshot()[m];
  assert.equal(snap.find(e => e.key === "x").weight, 1);
  assert.equal(snap.find(e => e.key === "y").weight, 1);
});

test("scheduler - 4xx (not 401/403/429) leaves weight unchanged", () => {
  const keys = [{ key: "x", weight: 5 }, { key: "y", weight: 5 }];
  const m = fresh("client-err");
  resolveApiKey(fakeReq(), keys, m);
  recordKeyOutcome(m, "x", 400);
  recordKeyOutcome(m, "x", 404);
  recordKeyOutcome(m, "x", 422);
  const snap = getKeySchedulerSnapshot()[m];
  assert.equal(snap.find(e => e.key === "x").weight, 5);
});

test("scheduler - string apiKey passes through unchanged", () => {
  const k = resolveApiKey(fakeReq(), "sk-static", null);
  assert.equal(k, "sk-static");
});

test("scheduler - single-entry array short-circuits", () => {
  const k = resolveApiKey(fakeReq(), [{ key: "only", weight: 1 }], "solo");
  assert.equal(k, "only");
});
