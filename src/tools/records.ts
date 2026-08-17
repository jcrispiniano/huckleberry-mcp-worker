import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { Huckleberry, TRACKERS, TrackerType } from "../huckleberry";
import { ok } from "./util";

export function registerRecordTools(server: McpServer, hb: Huckleberry) {
  server.registerTool(
    "delete_record",
    {
      description:
        "Permanently delete one logged record. Pass the interval_id reported by " +
        "the matching history tool (get_sleep_history, get_feeding_history, " +
        "get_diaper_history, get_growth_history). This cannot be undone, so " +
        "confirm the record with a history query before deleting it.",
      inputSchema: z.object({
        child_uid: z.string(),
        type: z
          .enum(["sleep", "feed", "diaper", "growth"])
          .describe(
            "Which tracker the record belongs to. Bottle and breastfeeding records are both 'feed'.",
          ),
        interval_id: z
          .string()
          .describe("The interval_id from the corresponding history tool"),
      }),
    },
    async ({ child_uid, type, interval_id }) => {
      await hb.validateChild(child_uid);

      const tracker = type as TrackerType;
      await hb.deleteRecord(tracker, child_uid, interval_id);

      return ok({
        success: true,
        message: `Deleted ${type} record ${interval_id} for child ${child_uid}`,
        type,
        interval_id,
        collection: `${TRACKERS[tracker].collection}/${child_uid}/${TRACKERS[tracker].sub}`,
      });
    },
  );
}
