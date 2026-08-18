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
import { registerRecordTools } from "./tools/records";

export interface Env {
  HUCKLEBERRY_EMAIL: string;
  HUCKLEBERRY_PASSWORD: string;
  HUCKLEBERRY_TIMEZONE?: string;
  MCP_AUTH_TOKEN: string;
  /**
   * Optional second token accepted in the URL path, for clients that cannot
   * send a custom header — claude.ai custom connectors take a URL and OAuth
   * credentials, with no field for `Authorization`.
   *
   * It is deliberately separate from MCP_AUTH_TOKEN: request paths end up in
   * access logs and history in a way that headers do not, so a leak here should
   * not compromise the header credential, and this one can be rotated alone.
   * Falls back to MCP_AUTH_TOKEN when unset.
   */
  MCP_URL_TOKEN?: string;
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
  // Deliberately no WWW-Authenticate header. That header invites the client to
  // negotiate authorization, which for MCP means discovering an OAuth server
  // and registering a client. There is no OAuth here — the token is either
  // presented correctly or it is not — so advertising a challenge only sends
  // clients down a flow that cannot succeed.
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
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
  registerRecordTools(server, hb);

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
        "huckleberry-mcp is running.\n" +
          "MCP endpoint: POST /mcp with an Authorization: Bearer header,\n" +
          "or POST /mcp/<token> for clients that cannot send headers.\n",
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

    // A token in the path authenticates the request on its own. The handler
    // only serves /mcp, so the request is rewritten to that route once the
    // token checks out.
    const pathToken = url.pathname.match(/^\/mcp\/(.+)$/)?.[1];
    let authenticated = false;

    // Anything that is not an MCP route must answer 404, never 401.
    //
    // Clients probe for OAuth metadata (/.well-known/oauth-protected-resource,
    // /.well-known/oauth-authorization-server, /register) before connecting. A
    // 401 on those paths reads as "this server has an authorization server",
    // which sends the client into dynamic client registration — a flow this
    // server does not implement, so connecting fails with a registration
    // error. A 404 tells the client there is no OAuth here, and it proceeds
    // with the URL as given.
    if (url.pathname !== "/mcp" && !pathToken) {
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (pathToken) {
      const expected = env.MCP_URL_TOKEN || env.MCP_AUTH_TOKEN;
      if (!tokensMatch(decodeURIComponent(pathToken), expected)) {
        return unauthorized();
      }

      authenticated = true;
      url.pathname = "/mcp";
      request = new Request(url, request);
    }

    // Preflight carries no Authorization header; let the handler answer it.
    if (!authenticated && request.method !== "OPTIONS") {
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
