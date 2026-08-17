import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { Huckleberry } from "../huckleberry";
import { ok } from "./util";

export function registerChildrenTools(server: McpServer, hb: Huckleberry) {
  server.registerTool(
    "list_children",
    {
      description:
        "List all child profiles registered in the Huckleberry account. " +
        "Use this tool first to get the child_uid values every other tool needs.",
      inputSchema: z.object({}),
    },
    async () => ok(await hb.getChildren()),
  );

  server.registerTool(
    "get_child_name",
    {
      description:
        "Get a child's display name from their UID. Returns null when the UID is unknown.",
      inputSchema: z.object({
        child_uid: z.string().describe("The child's unique identifier"),
      }),
    },
    async ({ child_uid }) => {
      const children = await hb.getChildren();
      const match = children.find((c) => c.uid === child_uid);
      return ok(match ? match.name : null);
    },
  );
}
