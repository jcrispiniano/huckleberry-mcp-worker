import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { DELETE_FIELD, Huckleberry, dbl } from "../huckleberry";
import { intervalId, shortId } from "../firestore";
import { isoToTimestamp, timestampToLocalIso } from "../tz";
import { ok } from "./util";

const SIDE = z.enum(["left", "right"]);

export function registerFeedingTools(server: McpServer, hb: Huckleberry) {
  server.registerTool(
    "log_bottle_feeding",
    {
      description:
        "Log a bottle feeding. Supports retroactive logging via the timestamp argument.",
      inputSchema: z.object({
        child_uid: z.string(),
        amount: z.number().positive(),
        bottle_type: z
          .enum(["Formula", "Breast Milk", "Mixed"])
          .default("Formula"),
        units: z.enum(["oz", "ml"]).default("oz"),
        timestamp: z
          .string()
          .optional()
          .describe("ISO datetime; defaults to now"),
      }),
    },
    async ({ child_uid, amount, bottle_type, units, timestamp }) => {
      await hb.validateChild(child_uid);

      const now = hb.nowSec();
      const feedTs = timestamp ? isoToTimestamp(timestamp, hb.tz) : now;
      const id = intervalId(now * 1000);

      await hb.db.setDoc(`feed/${child_uid}/intervals/${id}`, {
        mode: "bottle",
        start: feedTs,
        amount: dbl(amount),
        units,
        bottleType: bottle_type,
        lastUpdated: dbl(now),
        offset: hb.offset(),
        end_offset: hb.offset(),
      });

      await hb.db.updateDoc(`feed/${child_uid}`, {
        "prefs.lastBottle": {
          mode: "bottle",
          start: feedTs,
          amount: dbl(amount),
          units,
          bottleType: bottle_type,
          offset: hb.offset(),
        },
        "prefs.timestamp": { seconds: dbl(now) },
        "prefs.local_timestamp": dbl(now),
      });

      return ok({
        success: true,
        message: `Bottle feeding logged: ${amount}${units} of ${bottle_type} for child ${child_uid}`,
        amount,
        units,
        bottle_type,
        timestamp: timestampToLocalIso(feedTs, hb.tz),
        interval_id: id,
      });
    },
  );

  server.registerTool(
    "log_breastfeeding",
    {
      description:
        "Directly log a completed breastfeeding session without using the timer. " +
        "Durations are in MINUTES. Provide either end_time (with last_side) or " +
        "the per-side durations, not both.",
      inputSchema: z.object({
        child_uid: z.string(),
        start_time: z.string(),
        left_duration_minutes: z.number().optional(),
        right_duration_minutes: z.number().optional(),
        end_time: z.string().optional(),
        last_side: SIDE.optional(),
      }),
    },
    async ({
      child_uid,
      start_time,
      left_duration_minutes,
      right_duration_minutes,
      end_time,
      last_side,
    }) => {
      await hb.validateChild(child_uid);

      const startTs = isoToTimestamp(start_time, hb.tz);

      // The backend stores leftDuration/rightDuration in SECONDS — that is what
      // the app's own timer writes. The Python server passed the caller's
      // minutes straight through, so a 5 minute feed was recorded as 5 seconds.
      let leftSec: number;
      let rightSec: number;
      let side = last_side;

      if (end_time != null) {
        if (left_duration_minutes != null || right_duration_minutes != null) {
          throw new Error(
            "When using end_time, do not specify left_duration_minutes or right_duration_minutes",
          );
        }
        if (side == null) {
          throw new Error(
            "When using end_time, last_side is required to decide which breast the duration belongs to",
          );
        }

        const endTs = isoToTimestamp(end_time, hb.tz);
        const totalSec = endTs - startTs;
        if (totalSec <= 0) throw new Error("end_time must be after start_time");

        leftSec = side === "left" ? totalSec : 0;
        rightSec = side === "right" ? totalSec : 0;
      } else {
        if (left_duration_minutes == null && right_duration_minutes == null) {
          throw new Error(
            "Must provide either end_time OR at least one of left_duration_minutes / right_duration_minutes",
          );
        }

        leftSec = (left_duration_minutes ?? 0) * 60;
        rightSec = (right_duration_minutes ?? 0) * 60;

        if (side == null) side = rightSec >= leftSec ? "right" : "left";
      }

      const now = hb.nowSec();
      const id = intervalId(now * 1000);
      const totalSec = leftSec + rightSec;

      await hb.db.setDoc(`feed/${child_uid}/intervals/${id}`, {
        mode: "breast",
        start: startTs,
        lastSide: side,
        lastUpdated: dbl(now),
        leftDuration: dbl(leftSec),
        rightDuration: dbl(rightSec),
        offset: hb.offset(),
        end_offset: hb.offset(),
      });

      await hb.db.updateDoc(`feed/${child_uid}`, {
        "prefs.lastNursing": {
          mode: "breast",
          start: startTs,
          duration: dbl(totalSec),
          leftDuration: dbl(leftSec),
          rightDuration: dbl(rightSec),
          offset: hb.offset(),
        },
        "prefs.lastSide": { start: startTs, lastSide: side },
        "prefs.timestamp": { seconds: dbl(now) },
        "prefs.local_timestamp": dbl(now),
      });

      return ok({
        success: true,
        message: `Breastfeeding logged for child ${child_uid}`,
        start_time: timestampToLocalIso(startTs, hb.tz),
        left_duration_minutes: leftSec / 60,
        right_duration_minutes: rightSec / 60,
        total_duration_minutes: totalSec / 60,
        last_side: side,
        interval_id: id,
      });
    },
  );

  server.registerTool(
    "start_breastfeeding",
    {
      description: "Begin a breastfeeding timer on the given side.",
      inputSchema: z.object({ child_uid: z.string(), side: SIDE }),
    },
    async ({ child_uid, side }) => {
      await hb.validateChild(child_uid);

      const now = hb.nowSec();

      await hb.db.mergeDoc(`feed/${child_uid}`, {
        timer: {
          active: true,
          paused: false,
          timestamp: { seconds: dbl(now) },
          local_timestamp: dbl(now),
          feedStartTime: dbl(now),
          timerStartTime: dbl(now),
          uuid: shortId(),
          leftDuration: dbl(0),
          rightDuration: dbl(0),
          lastSide: "left",
          activeSide: side,
        },
      });

      return ok({
        success: true,
        message: `Breastfeeding started on ${side} side for child ${child_uid}`,
        side,
        timestamp: timestampToLocalIso(now, hb.tz),
      });
    },
  );

  server.registerTool(
    "pause_feeding",
    {
      description: "Pause an active, running feeding session.",
      inputSchema: z.object({ child_uid: z.string() }),
    },
    async ({ child_uid }) => {
      await hb.validateChild(child_uid);

      const timer = await hb.getTimer("feed", child_uid);
      if (!timer?.active) {
        return ok({
          success: false,
          message: "Feeding is not active; ignoring pause request",
        });
      }
      if (timer.paused) {
        return ok({ success: false, message: "Feeding is already paused" });
      }

      const now = hb.nowSec();
      const currentSide = timer.activeSide ?? timer.lastSide ?? "left";
      const elapsed = now - Number(timer.timerStartTime ?? now);

      let left = Number(timer.leftDuration ?? 0);
      let right = Number(timer.rightDuration ?? 0);
      if (currentSide === "left") left += elapsed;
      else right += elapsed;

      await hb.db.updateDoc(`feed/${child_uid}`, {
        "timer.paused": true,
        "timer.active": true,
        "timer.timestamp": { seconds: dbl(now) },
        "timer.local_timestamp": dbl(now),
        "timer.leftDuration": dbl(left),
        "timer.rightDuration": dbl(right),
        "timer.lastSide": currentSide,
        "timer.activeSide": DELETE_FIELD,
      });

      return ok({
        success: true,
        message: `Feeding tracking paused for child ${child_uid}`,
        left_duration_minutes: left / 60,
        right_duration_minutes: right / 60,
        timestamp: timestampToLocalIso(now, hb.tz),
      });
    },
  );

  server.registerTool(
    "resume_feeding",
    {
      description:
        "Resume a paused feeding session, optionally on a specific side.",
      inputSchema: z.object({
        child_uid: z.string(),
        side: SIDE.optional(),
      }),
    },
    async ({ child_uid, side }) => {
      await hb.validateChild(child_uid);

      const timer = await hb.getTimer("feed", child_uid);
      if (!timer?.active) {
        return ok({
          success: false,
          message: "Feeding is not active; ignoring resume request",
        });
      }
      if (!timer.paused) {
        return ok({ success: false, message: "Feeding is not paused" });
      }

      const now = hb.nowSec();
      const resumeSide = side ?? timer.lastSide ?? "left";

      await hb.db.updateDoc(`feed/${child_uid}`, {
        "timer.paused": false,
        "timer.active": true,
        "timer.timestamp": { seconds: dbl(now) },
        "timer.local_timestamp": dbl(now),
        "timer.timerStartTime": dbl(now),
        "timer.activeSide": resumeSide,
        "timer.lastSide": "none",
      });

      return ok({
        success: true,
        message: `Feeding tracking resumed for child ${child_uid}`,
        side: resumeSide,
        timestamp: timestampToLocalIso(now, hb.tz),
      });
    },
  );

  server.registerTool(
    "switch_feeding_side",
    {
      description:
        "Switch the active breast during a feeding session (left <-> right).",
      inputSchema: z.object({ child_uid: z.string() }),
    },
    async ({ child_uid }) => {
      await hb.validateChild(child_uid);

      const timer = await hb.getTimer("feed", child_uid);
      if (!timer?.active) {
        return ok({
          success: false,
          message: "Feeding is not active; ignoring switch request",
        });
      }

      const now = hb.nowSec();
      const currentSide = timer.activeSide ?? timer.lastSide ?? "left";
      const newSide = currentSide === "left" ? "right" : "left";

      let left = Number(timer.leftDuration ?? 0);
      let right = Number(timer.rightDuration ?? 0);

      // A paused timer has already banked its elapsed time.
      if (!timer.paused) {
        const elapsed = now - Number(timer.timerStartTime ?? now);
        if (currentSide === "left") left += elapsed;
        else right += elapsed;
      }

      await hb.db.updateDoc(`feed/${child_uid}`, {
        "timer.paused": false,
        "timer.lastSide": "none",
        "timer.timestamp": { seconds: dbl(now) },
        "timer.local_timestamp": dbl(now),
        "timer.timerStartTime": dbl(now),
        "timer.activeSide": newSide,
        "timer.leftDuration": dbl(left),
        "timer.rightDuration": dbl(right),
      });

      return ok({
        success: true,
        message: `Switched feeding side from ${currentSide} to ${newSide}`,
        side: newSide,
        timestamp: timestampToLocalIso(now, hb.tz),
      });
    },
  );

  server.registerTool(
    "complete_feeding",
    {
      description:
        "Complete the active feeding session and save it to the child's history.",
      inputSchema: z.object({ child_uid: z.string() }),
    },
    async ({ child_uid }) => {
      await hb.validateChild(child_uid);

      const timer = await hb.getTimer("feed", child_uid);
      if (!timer?.active) {
        return ok({
          success: false,
          message: "Feeding already completed; ignoring duplicate request",
        });
      }
      if (!timer.timerStartTime) {
        throw new Error("Missing timerStartTime for feeding");
      }

      const now = hb.nowSec();
      const timerStart = Number(timer.timerStartTime);

      let left = Number(timer.leftDuration ?? 0);
      let right = Number(timer.rightDuration ?? 0);

      if (!timer.paused) {
        const elapsed = now - timerStart;
        const currentSide = timer.activeSide ?? timer.lastSide ?? "left";
        if (currentSide === "left") left += elapsed;
        else right += elapsed;
      }

      const total = left + right;
      const feedStart = Number(timer.feedStartTime ?? timerStart);

      let lastSide = timer.activeSide ?? timer.lastSide ?? "right";
      if (lastSide === "none") lastSide = right >= left ? "right" : "left";

      const id = intervalId(now * 1000);

      await hb.db.setDoc(`feed/${child_uid}/intervals/${id}`, {
        mode: "breast",
        start: feedStart,
        lastSide,
        lastUpdated: dbl(now),
        leftDuration: dbl(left),
        rightDuration: dbl(right),
        offset: hb.offset(),
        end_offset: hb.offset(),
      });

      await hb.db.updateDoc(`feed/${child_uid}`, {
        "timer.active": false,
        "timer.paused": true,
        "timer.timestamp": { seconds: dbl(now) },
        "timer.local_timestamp": dbl(now),
        "timer.lastSide": lastSide,
        "timer.leftDuration": DELETE_FIELD,
        "timer.rightDuration": DELETE_FIELD,
        "timer.activeSide": DELETE_FIELD,
        "prefs.lastNursing": {
          mode: "breast",
          start: dbl(feedStart),
          duration: dbl(total),
          leftDuration: dbl(left),
          rightDuration: dbl(right),
          offset: hb.offset(),
        },
        "prefs.lastSide": { start: dbl(feedStart), lastSide },
        "prefs.timestamp": { seconds: dbl(now) },
        "prefs.local_timestamp": dbl(now),
      });

      return ok({
        success: true,
        message: `Feeding tracking completed and saved for child ${child_uid}`,
        left_duration_minutes: left / 60,
        right_duration_minutes: right / 60,
        total_duration_minutes: total / 60,
        last_side: lastSide,
        interval_id: id,
        timestamp: timestampToLocalIso(now, hb.tz),
      });
    },
  );

  server.registerTool(
    "cancel_feeding",
    {
      description:
        "Cancel the active feeding session and discard it (nothing is saved).",
      inputSchema: z.object({ child_uid: z.string() }),
    },
    async ({ child_uid }) => {
      await hb.validateChild(child_uid);

      const timer = await hb.getTimer("feed", child_uid);
      const now = hb.nowSec();

      await hb.db.updateDoc(`feed/${child_uid}`, {
        timer: {
          active: false,
          paused: false,
          timestamp: { seconds: dbl(now) },
          timerStartTime: null,
          uuid: timer?.uuid ?? shortId(),
          local_timestamp: dbl(now),
          leftDuration: dbl(0),
          rightDuration: dbl(0),
          lastSide: "left",
        },
      });

      return ok({
        success: true,
        message: `Feeding tracking cancelled for child ${child_uid}`,
        timestamp: timestampToLocalIso(now, hb.tz),
      });
    },
  );

  server.registerTool(
    "get_feeding_history",
    {
      description:
        "Get feeding history for a child. Dates are YYYY-MM-DD and inclusive on both ends; " +
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
        "feed",
        child_uid,
        "intervals",
        start,
        end,
      );

      const result = intervals.map((i) => {
        const left = Number(i.leftDuration ?? 0);
        const right = Number(i.rightDuration ?? 0);

        const row: Record<string, unknown> = {
          start_time: timestampToLocalIso(i.start as number, hb.tz),
          mode: (i.mode as string) ?? "breast",
          left_duration_minutes: Math.floor(left / 60),
          right_duration_minutes: Math.floor(right / 60),
          is_multi_entry: i.__multi,
        };

        if (i.mode === "bottle") {
          row.amount = i.amount ?? null;
          row.units = i.units ?? null;
          row.bottle_type = i.bottleType ?? null;
        }

        return row;
      });

      return ok(result);
    },
  );
}
