import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { Huckleberry, dbl } from "../huckleberry";
import { intervalId } from "../firestore";
import { isoToTimestamp, timestampToLocalIso } from "../tz";
import { ok } from "./util";

/** Head circumference carries its own unit token in the app: "hcm" / "hin". */
const UNITS = {
  metric: { weight: "kg", height: "cm", head: "hcm" },
  imperial: { weight: "lbs", height: "in", head: "hin" },
} as const;

export function registerGrowthTools(server: McpServer, hb: Huckleberry) {
  server.registerTool(
    "log_growth",
    {
      description:
        "Log growth measurements. At least one of weight, height or head is required. " +
        "Supports retroactive logging via the timestamp argument.",
      inputSchema: z.object({
        child_uid: z.string(),
        weight: z.number().optional(),
        height: z.number().optional(),
        head: z.number().optional(),
        units: z.enum(["imperial", "metric"]).default("imperial"),
        timestamp: z
          .string()
          .optional()
          .describe("ISO datetime; defaults to now"),
      }),
    },
    async ({ child_uid, weight, height, head, units, timestamp }) => {
      await hb.validateChild(child_uid);

      if (weight == null && height == null && head == null) {
        throw new Error(
          "At least one measurement (weight, height, or head) must be provided",
        );
      }

      const at = timestamp ? isoToTimestamp(timestamp, hb.tz) : hb.nowSec();
      const id = intervalId(at * 1000);
      const u = UNITS[units];

      const entry: Record<string, unknown> = {
        _id: id,
        type: "health",
        mode: "growth",
        start: dbl(at),
        lastUpdated: dbl(at),
        offset: hb.offset(),
        isNight: false,
        multientry_key: null,
      };

      if (weight != null) {
        entry.weight = dbl(weight);
        entry.weightUnits = u.weight;
      }
      if (height != null) {
        entry.height = dbl(height);
        entry.heightUnits = u.height;
      }
      if (head != null) {
        entry.head = dbl(head);
        entry.headUnits = u.head;
      }

      // Health records live under a "data" subcollection, not "intervals".
      await hb.db.setDoc(`health/${child_uid}/data/${id}`, entry);

      await hb.db.updateDoc(`health/${child_uid}`, {
        "prefs.lastGrowthEntry": entry,
        "prefs.timestamp": { seconds: dbl(at) },
        "prefs.local_timestamp": dbl(at),
      });

      const measurements: string[] = [];
      if (weight != null) measurements.push(`weight: ${weight}${u.weight}`);
      if (height != null) measurements.push(`height: ${height}${u.height}`);
      if (head != null) measurements.push(`head: ${head}`);

      return ok({
        success: true,
        message: `Logged growth measurements (${measurements.join(", ")}) for child ${child_uid}`,
        weight: weight ?? null,
        height: height ?? null,
        head: head ?? null,
        units,
        timestamp: timestampToLocalIso(at, hb.tz),
        interval_id: id,
      });
    },
  );

  server.registerTool(
    "get_latest_growth",
    {
      description: "Get the most recent growth measurements for a child.",
      inputSchema: z.object({ child_uid: z.string() }),
    },
    async ({ child_uid }) => {
      await hb.validateChild(child_uid);

      const doc = await hb.db.getDoc(`health/${child_uid}`);
      const prefs = (doc?.prefs as Record<string, any>) ?? {};
      const last = (prefs.lastGrowthEntry as Record<string, any>) ?? {};

      if (last.weight == null && last.height == null && last.head == null) {
        return ok({ message: "No growth measurements found for this child" });
      }

      return ok({
        weight: last.weight ?? null,
        height: last.height ?? null,
        head: last.head ?? null,
        weight_units: last.weightUnits ?? "kg",
        height_units: last.heightUnits ?? "cm",
        head_units: last.headUnits ?? "hcm",
        timestamp: last.start
          ? timestampToLocalIso(Number(last.start), hb.tz)
          : null,
      });
    },
  );

  server.registerTool(
    "get_growth_history",
    {
      description:
        "Get growth measurement history for a child. Dates are YYYY-MM-DD and inclusive on both ends; " +
        "start_date defaults to 30 days ago and end_date to now.",
      inputSchema: z.object({
        child_uid: z.string(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
      }),
    },
    async ({ child_uid, start_date, end_date }) => {
      await hb.validateChild(child_uid);

      const { start, end } = hb.resolveRange(start_date, end_date, 30);
      const entries = await hb.getIntervals(
        "health",
        child_uid,
        "data",
        start,
        end,
      );

      const result = entries.map((e) => ({
        interval_id: e.__id,
        timestamp: timestampToLocalIso(e.start as number, hb.tz),
        weight: (e.weight as number) ?? null,
        height: (e.height as number) ?? null,
        head: (e.head as number) ?? null,
        is_multi_entry: e.__multi,
      }));

      return ok(result);
    },
  );
}
