// Drives the built server (dist/) over an in-memory MCP transport with the Apify API stubbed.
// Run with `npm test` (builds first).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../dist/server.js";
import catalog from "../src/catalog.json" with { type: "json" };

const realFetch = globalThis.fetch;
let calls;
let routes;

function stubApify(handler) {
  routes = handler;
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, query: Object.fromEntries(u.searchParams), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers });
    const { status = 200, json } = routes(u, init);
    return new Response(json === undefined ? "" : JSON.stringify(json), { status });
  };
}

async function connect() {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([createServer().connect(serverT), client.connect(clientT)]);
  return client;
}

const run = (over = {}) => ({ id: "run1", status: "SUCCEEDED", defaultDatasetId: "ds1", stats: { itemCount: 2 }, ...over });
const parse = (res) => JSON.parse(res.content[0].text);

beforeEach(() => {
  calls = [];
  process.env.APIFY_TOKEN = "test-token";
});
afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.APIFY_TOKEN;
  delete process.env.APIFY_API_TOKEN;
});

test("lists every catalog scraper plus get_run_results", async () => {
  const { tools } = await (await connect()).listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...catalog.actors.map((a) => a.tool), "get_run_results"].sort());
});

test("every tool declares all four hints as booleans", async () => {
  const { tools } = await (await connect()).listTools();
  for (const t of tools) {
    for (const h of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"]) {
      assert.equal(typeof t.annotations?.[h], "boolean", `${t.name} is missing ${h}`);
    }
  }
});

test("scraper tools are marked as spending credit; get_run_results as read-only", async () => {
  const { tools } = await (await connect()).listTools();
  for (const t of tools) {
    if (t.name === "get_run_results") {
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.annotations.idempotentHint, true);
    } else {
      assert.equal(t.annotations.readOnlyHint, false);
    }
    assert.equal(t.annotations.destructiveHint, false);
  }
});

test("a scraper call starts the right actor with the spend cap and default limit", async () => {
  stubApify((u) =>
    u.pathname.startsWith("/v2/acts/") ? { status: 201, json: { data: run() } } : { json: [{ a: 1 }, { a: 2 }] },
  );
  const res = await (await connect()).callTool({ name: "scrape_ats_jobs", arguments: { companies: ["stripe"], maxChargeUsd: 0.5 } });
  const start = calls[0];
  assert.equal(start.method, "POST");
  assert.equal(start.path, "/v2/acts/zrk1212~ats-jobs-monitor/runs");
  assert.equal(start.query.maxTotalChargeUsd, "0.5");
  assert.deepEqual(start.body, { companies: ["stripe"], maxJobs: 50 });
  assert.equal(start.headers.Authorization, "Bearer test-token");
  assert.equal(calls[1].path, "/v2/datasets/ds1/items");
  const out = parse(res);
  assert.equal(out.status, "SUCCEEDED");
  assert.deepEqual(out.items, [{ a: 1 }, { a: 2 }]);
});

test("extraInput passes through and explicit fields win over it", async () => {
  stubApify((u) => (u.pathname.startsWith("/v2/acts/") ? { json: { data: run() } } : { json: [] }));
  await (await connect()).callTool({
    name: "scrape_telegram_channel",
    arguments: { channels: ["durov"], extraInput: { onlyWithMedia: true, channels: ["ignored"] } },
  });
  assert.deepEqual(calls[0].body, { onlyWithMedia: true, channels: ["durov"] });
});

test("a run still going at the deadline returns its runId and a note", async () => {
  stubApify(() => ({ json: { data: run({ status: "RUNNING" }) } }));
  const out = parse(await (await connect()).callTool({ name: "scrape_telegram_channel", arguments: { channels: ["durov"], waitSecs: 0 } }));
  assert.equal(out.status, "RUNNING");
  assert.equal(out.runId, "run1");
  assert.match(out.note, /get_run_results/);
  assert.deepEqual(out.items, []);
});

test("get_run_results pages with limit and offset", async () => {
  stubApify((u) => (u.pathname === "/v2/actor-runs/run1" ? { json: { data: run() } } : { json: [{ n: 3 }] }));
  const out = parse(await (await connect()).callTool({ name: "get_run_results", arguments: { runId: "run1", limit: 1, offset: 2 } }));
  assert.equal(calls[1].query.limit, "1");
  assert.equal(calls[1].query.offset, "2");
  assert.deepEqual(out.items, [{ n: 3 }]);
});

test("oversized results are truncated with a paging note", async () => {
  const big = Array.from({ length: 200 }, (_, i) => ({ i, text: "x".repeat(1000) }));
  stubApify((u) => (u.pathname === "/v2/actor-runs/run1" ? { json: { data: run() } } : { json: big }));
  const res = await (await connect()).callTool({ name: "get_run_results", arguments: { runId: "run1", limit: 200 } });
  assert.ok(res.content[0].text.length <= 60_000);
  const out = parse(res);
  assert.ok(out.items.length < 200);
  assert.match(out.note, /truncated/);
});

test("APIFY_API_TOKEN works when APIFY_TOKEN is unset", async () => {
  delete process.env.APIFY_TOKEN;
  process.env.APIFY_API_TOKEN = "alt-token";
  stubApify((u) => (u.pathname === "/v2/actor-runs/run1" ? { json: { data: run() } } : { json: [] }));
  await (await connect()).callTool({ name: "get_run_results", arguments: { runId: "run1" } });
  assert.equal(calls[0].headers.Authorization, "Bearer alt-token");
});

test("a missing token is reported as a tool error, without calling Apify", async () => {
  delete process.env.APIFY_TOKEN;
  stubApify(() => ({ json: {} }));
  const res = await (await connect()).callTool({ name: "get_run_results", arguments: { runId: "run1" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /APIFY_TOKEN is not set/);
  assert.equal(calls.length, 0);
});

test("Apify API errors surface as tool errors", async () => {
  stubApify(() => ({ status: 402, json: { error: { message: "Not enough credit" } } }));
  const res = await (await connect()).callTool({ name: "scrape_telegram_channel", arguments: { channels: ["durov"] } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Apify API 402/);
});

test("required inputs are enforced", async () => {
  stubApify(() => ({ json: {} }));
  const res = await (await connect()).callTool({ name: "scrape_telegram_channel", arguments: {} });
  assert.equal(res.isError, true);
  assert.equal(calls.length, 0);
});
