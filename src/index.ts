/**
 * Huckleberry MCP server, as a Cloudflare Worker.
 *
 * A TypeScript port of bckenstler/py-huckleberry-mcp. The original is a Python
 * stdio server that reaches Firestore through the gRPC SDK, which Workers
 * cannot run; this version speaks the Firebase REST API over `fetch` and serves
 * MCP over Streamable HTTP at /mcp.
 *
 * The endpoint is public, so every request must present the bearer token held
 * in the MCP_AUTH_TOKEN secret.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

import { Huckleberry } from "./huckleberry";
import { registerChildrenTools } from "./tools/children";
import { registerSleepTools } from "./tools/sleep";
import { registerFeedingTools } from "./tools/feeding";
import { registerDiaperTools } from "./tools/diaper";
import { registerGrowthTools } from "./tools/growth";

export interface Env {
  HUCKLEBERRY_EMAIL: string;
  HUCKLEBERRY_PASSWORD: string;
  HUCKLEBERRY_TIMEZONE?: string;
  MCP_AUTH_TOKEN: string;
}

/** Length-independent comparison, so a wrong token leaks nothing by timing. */
function tokensMatch(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const left = enc.encode(a);
  const right = enc.encode(b);

  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);

  for (let i = 0; i < len; i++) {
    diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  }

  return diff === 0;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized" }),
    {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "WWW-Authenticate": 'Bearer realm="huckleberry-mcp"',
      },
    },
  );
}

function buildServer(env: Env): McpServer {
  const server = new McpServer({
    name: "huckleberry",
    version: "1.0.0",
  });

  const hb = new Huckleberry(
    env.HUCKLEBERRY_EMAIL,
    env.HUCKLEBERRY_PASSWORD,
    env.HUCKLEBERRY_TIMEZONE || "America/New_York",
  );

  registerChildrenTools(server, hb);
  registerSleepTools(server, hb);
  registerFeedingTools(server, hb);
  registerDiaperTools(server, hb);
  registerGrowthTools(server, hb);

  return server;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        "huckleberry-mcp is running. MCP endpoint: POST /mcp (bearer token required).\n",
        { headers: { "Content-Type": "text/plain" } },
      );
    }

    if (!env.MCP_AUTH_TOKEN) {
      return new Response(
        JSON.stringify({
          error: "server_misconfigured",
          detail: "MCP_AUTH_TOKEN is not set",
        }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // Preflight carries no Authorization header; let the handler answer it.
    if (request.method !== "OPTIONS") {
      const header = request.headers.get("Authorization") ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";

      if (!token || !tokensMatch(token, env.MCP_AUTH_TOKEN)) {
        return unauthorized();
      }
    }

    const handler = createMcpHandler(() => buildServer(env));
    return handler(request, env, ctx);
  },
};
