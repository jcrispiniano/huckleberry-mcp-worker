import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { Huckleberry, dbl } from "../huckleberry";
import { intervalId } from "../firestore";
import { isoToTimestamp, timestampToLocalIso } from "../tz";
import { ok } from "./util";

const AMOUNT = z.enum(["little", "medium", "big"]);

/** The app encodes amounts as a 0/50/100 scale. */
const AMOUNT_SCALE: Record<string, number> = {
  little: 0,
  medium: 50,
  big: 100,
};

export function registerDiaperTools(server: McpServer, hb: Huckleberry) {
  server.registerTool(
    "log_diaper",
    {
      description:
        "Log a diaper change. Supports retroactive logging via the timestamp argument.",
      inputSchema: z.object({
        child_uid: z.string(),
        mode: z.enum(["pee", "poo", "both", "dry"]).default("both"),
        pee_amount: AMOUNT.optional(),
        poo_amount: AMOUNT.optional(),
        color: z
          .enum(["yellow", "brown", "black", "green", "red", "gray"])
          .optional(),
        consistency: z
          .enum([
            "solid",
            "loose",
            "runny",
            "mucousy",
            "hard",
            "pebbles",
            "diarrhea",
          ])
          .optional(),
        diaper_rash: z.boolean().default(false),
        notes: z.string().optional(),
        timestamp: z
          .string()
          .optional()
          .describe("ISO datetime; defaults to now"),
      }),
    },
    async ({
      child_uid,
      mode,
      pee_amount,
      poo_amount,
      color,
      consistency,
      diaper_rash,
      notes,
      timestamp,
    }) => {
      await hb.validateChild(child_uid);

      const changeTime = timestamp
        ? isoToTimestamp(timestamp, hb.tz)
        : hb.nowSec();

      const id = intervalId(changeTime * 1000);

      const data: Record<string, unknown> = {
        start: dbl(changeTime),
        lastUpdated: dbl(changeTime),
        mode,
        offset: hb.offset(),
      };

      const quantity: Record<string, unknown> = {};
      if (pee_amount) quantity.pee = dbl(AMOUNT_SCALE[pee_amount]);
      if (poo_amount) quantity.poo = dbl(AMOUNT_SCALE[poo_amount]);
      if (Object.keys(quantity).length) data.quantity = quantity;

      if (color) data.color = color;
      if (consistency) data.consistency = consistency;
      if (diaper_rash) data.diaperRash = true;
      if (notes) data.notes = notes;

      await hb.db.setDoc(`diaper/${child_uid}/intervals/${id}`, data);

      await hb.db.updateDoc(`diaper/${child_uid}`, {
        "prefs.lastDiaper": {
          start: dbl(changeTime),
          mode,
          offset: hb.offset(),
        },
        "prefs.timestamp": { seconds: dbl(changeTime) },
        "prefs.local_timestamp": dbl(changeTime),
      });

      const parts = [`Logged diaper change (${mode})`];
      if (color) parts.push(`color: ${color}`);
      if (consistency) parts.push(`consistency: ${consistency}`);

      return ok({
        success: true,
        message: `${parts.join(", ")} for child ${child_uid}`,
        mode,
        color: color ?? null,
        consistency: consistency ?? null,
        timestamp: timestampToLocalIso(changeTime, hb.tz),
        interval_id: id,
      });
    },
  );

  server.registerTool(
    "get_diaper_history",
    {
      description:
        "Get diaper change history for a child. Dates are YYYY-MM-DD and inclusive on both ends; " +
        "start_date defaults to 7 days ago and end_date to now.",
      inputSchema: z.object({
        child_uid: z.string(),
        start_date: z.string().optional(),
        end_date: z.string().optional(),
      }),
    },
    async ({ child_uid, start_date, end_date }) => {
      await hb.validateChild(child_uid);

      const { start, end } = hb.resolveRange(start_date, end_date, 7);
      const intervals = await hb.getIntervals(
        "diaper",
        child_uid,
        "intervals",
        start,
        end,
      );

      const result = intervals.map((i) => ({
        timestamp: timestampToLocalIso(i.start as number, hb.tz),
        mode: (i.mode as string) ?? null,
        color: (i.color as string) ?? null,
        consistency: (i.consistency as string) ?? null,
        notes: (i.notes as string) ?? null,
        is_multi_entry: i.__multi,
      }));

      return ok(result);
    },
  );
}
