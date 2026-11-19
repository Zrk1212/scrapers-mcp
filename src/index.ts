#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import catalog from "./catalog.json" with { type: "json" };

const API = "https://api.apify.com/v2";
const VERSION = "1.0.0";
const MAX_CHARS = 60_000;
const DEFAULT_CAP_USD = Number(process.env.ZRK_MAX_CHARGE_USD ?? 1);

type Param = {
  name: string;
  type: "string" | "string[]" | "integer" | "boolean" | "enum";
  description: string;
  required?: boolean;
  values?: string[];
};

function token(): string {
  const t = process.env.APIFY_TOKEN ?? process.env.APIFY_API_TOKEN;
  if (!t) {
    throw new Error(
      "APIFY_TOKEN is not set. Get a free token at https://console.apify.com/settings/integrations and add it to this server's env.",
    );
  }
  return t;
}

async function apify(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
      "User-Agent": `zrk-scrapers-mcp/${VERSION}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Apify API ${res.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

function zodFor(p: Param): z.ZodTypeAny {
  let s: z.ZodTypeAny;
  switch (p.type) {
    case "string[]":
      s = z.array(z.string());
      break;
    case "integer":
      s = z.number().int();
      break;
    case "boolean":
      s = z.boolean();
      break;
    case "enum":
      s = z.enum(p.values as [string, ...string[]]);
      break;
    default:
      s = z.string();
  }
  s = s.describe(p.description);
  return p.required ? s : s.optional();
}

const TERMINAL = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);

async function itemsFor(run: any, limit: number, offset = 0) {
  const items = await apify(
    `/datasets/${run.defaultDatasetId}/items?clean=true&format=json&limit=${limit}&offset=${offset}`,
  );
  return items as unknown[];
}

function respond(run: any, items: unknown[] | null, note?: string) {
  const header = {
    runId: run.id,
    status: run.status,
    itemCount: run.stats?.itemCount ?? undefined,
    consoleUrl: `https://console.apify.com/view/runs/${run.id}`,
    datasetId: run.defaultDatasetId,
    ...(note ? { note } : {}),
  };
  let body = JSON.stringify({ ...header, items: items ?? [] }, null, 1);
  if (body.length > MAX_CHARS && items) {
    let n = items.length;
    while (n > 1 && body.length > MAX_CHARS) {
      n = Math.floor(n / 2);
      body = JSON.stringify(
        {
          ...header,
          note: `Output truncated to ${n} of ${items.length} items. Call get_run_results with offset to page through the rest.`,
          items: items.slice(0, n),
        },
        null,
        1,
      );
    }
  }
  return { content: [{ type: "text" as const, text: body }] };
}

const server = new McpServer({ name: "zrk-scrapers", version: VERSION });

for (const a of catalog.actors) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const p of a.params as Param[]) shape[p.name] = zodFor(p);
  shape.maxItems = z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe("Most result rows to return in this response (default 50). The run may produce more; page with get_run_results.");
  shape.maxChargeUsd = z
    .number()
    .positive()
    .optional()
    .describe(`Hard spending cap for this run in USD (default ${DEFAULT_CAP_USD}). Apify stops charging when it is reached.`);
  shape.waitSecs = z
    .number()
    .int()
    .min(0)
    .max(280)
    .optional()
    .describe("Seconds to wait for the run to finish (default 120). If it is still running, use get_run_results later.");
  shape.extraInput = z
    .record(z.string(), z.unknown())
    .optional()
    .describe(`Any other input field of the Apify actor ${a.actor}, passed through as-is. See https://apify.com/${a.actor}/input-schema`);

  server.registerTool(
    a.tool,
    {
      title: a.title,
      description: `${a.description} Runs the Apify actor ${a.actor} on your Apify account.`,
      inputSchema: shape,
      // Not read-only: every run spends Apify credit, so clients should ask before calling.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args: Record<string, any>) => {
      const { maxItems = 50, maxChargeUsd = DEFAULT_CAP_USD, waitSecs = 120, extraInput = {}, ...fields } = args;
      const input: Record<string, unknown> = { ...extraInput, ...fields };
      if ("limitParam" in a && a.limitParam && input[a.limitParam] === undefined) {
        input[a.limitParam] = maxItems;
      }
      const q = new URLSearchParams({ waitForFinish: String(Math.min(waitSecs, 60)) });
      q.set("maxTotalChargeUsd", String(maxChargeUsd));
      const actorPath = a.actor.replace("/", "~");
      let run = (await apify(`/acts/${actorPath}/runs?${q}`, { method: "POST", body: JSON.stringify(input) })).data;

      const deadline = Date.now() + waitSecs * 1000;
      while (!TERMINAL.has(run.status) && Date.now() < deadline) {
        const left = Math.max(1, Math.min(60, Math.floor((deadline - Date.now()) / 1000)));
        run = (await apify(`/actor-runs/${run.id}?waitForFinish=${left}`)).data;
      }
      if (!TERMINAL.has(run.status)) {
        return respond(run, null, "Still running. Call get_run_results with this runId in a minute.");
      }
      const items = await itemsFor(run, maxItems);
      const note = run.status === "SUCCEEDED" ? undefined : `Run ended with status ${run.status}; partial results shown.`;
      return respond(run, items, note);
    },
  );
}

server.registerTool(
  "get_run_results",
  {
    title: "Get run results",
    description: "Get the status and result rows of a run started by one of the other tools. Use it for runs that were still running, or to page through large results.",
    inputSchema: {
      runId: z.string().describe("The runId returned by a scraper tool."),
      limit: z.number().int().min(1).max(1000).optional().describe("Rows to return (default 50)."),
      offset: z.number().int().min(0).optional().describe("Rows to skip (default 0)."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ runId, limit = 50, offset = 0 }) => {
    const run = (await apify(`/actor-runs/${runId}`)).data;
    if (!TERMINAL.has(run.status)) return respond(run, null, "Still running. Try again shortly.");
    return respond(run, await itemsFor(run, limit, offset));
  },
);

await server.connect(new StdioServerTransport());
