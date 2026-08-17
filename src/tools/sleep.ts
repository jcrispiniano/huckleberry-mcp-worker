import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { DELETE_FIELD, Huckleberry, dbl, emptySleepDetails } from "../huckleberry";
import { shortId } from "../firestore";
import { isoToTimestamp, timestampToLocalIso } from "../tz";
import { ok } from "./util";

export function registerSleepTools(server: McpServer, hb: Huckleberry) {
  server.registerTool(
    "log_sleep",
    {
      description:
        "Directly log a completed sleep session without using the timer. " +
        "Useful for retroactive logging or importing sleep data. " +
        "Provide either end_time or duration_minutes, not both.",
      inputSchema: z.object({
        child_uid: z.string(),
        start_time: z
          .string()
          .describe(
            'Sleep start in ISO format, e.g. "2026-08-17T15:47:00". Naive values are read in the configured timezone.',
          ),
        end_time: z.string().optional(),
        duration_minutes: z.number().int().optional(),
      }),
    },
    async ({ child_uid, start_time, end_time, duration_minutes }) => {
      await hb.validateChild(child_uid);

      if (end_time == null && duration_minutes == null) {
        throw new Error("Either end_time or duration_minutes must be provided");
      }
      if (end_time != null && duration_minutes != null) {
        throw new Error(
          "Provide either end_time or duration_minutes, not both",
        );
      }

      const startTs = isoToTimestamp(start_time, hb.tz);

      let durationSec: number;
      let endTs: number;

      if (duration_minutes != null) {
        durationSec = duration_minutes * 60;
        endTs = startTs + durationSec;
      } else {
        endTs = isoToTimestamp(end_time!, hb.tz);
        durationSec = endTs - startTs;
        if (durationSec <= 0) {
          throw new Error("end_time must be after start_time");
        }
      }

      const id = shortId();
      const now = hb.nowSec();

      await hb.db.setDoc(`sleep/${child_uid}/intervals/${id}`, {
        _id: id,
        start: startTs,
        duration: durationSec,
        offset: hb.offset(),
        end_offset: hb.offset(),
        details: emptySleepDetails(),
        lastUpdated: dbl(now),
      });

      await hb.db.updateDoc(`sleep/${child_uid}`, {
        "prefs.lastSleep": {
          start: startTs,
          duration: durationSec,
          offset: hb.offset(),
        },
        "prefs.timestamp": { seconds: dbl(now) },
        "prefs.local_timestamp": dbl(now),
      });

      return ok({
        success: true,
        message: `Sleep logged for child ${child_uid}`,
        start_time: timestampToLocalIso(startTs, hb.tz),
        end_time: timestampToLocalIso(endTs, hb.tz),
        duration_minutes: Math.floor(durationSec / 60),
        interval_id: id,
      });
    },
  );

  server.registerTool(
    "start_sleep",
    {
      description:
        "Begin a sleep tracking session (starts the timer for this child).",
      inputSchema: z.object({ child_uid: z.string() }),
    },
    async ({ child_uid }) => {
      await hb.validateChild(child_uid);

      const now = hb.nowSec();

      await hb.db.mergeDoc(`sleep/${child_uid}`, {
        timer: {
          active: true,
          paused: false,
          timestamp: { seconds: dbl(now) },
          local_timestamp: dbl(now),
          timerStartTime: dbl(now * 1000),
          uuid: shortId(),
          details: emptySleepDetails(),
        },
      });

      return ok({
        success: true,
        message: `Sleep tracking started for child ${child_uid}`,
        timestamp: timestampToLocalIso(now, hb.tz),
      });
    },
  );

  server.registerTool(
    "pause_sleep",
    {
      description: "Pause an active, running sleep tracking session.",
      inputSchema: z.object({ child_uid: z.string() }),
    },
    async ({ child_uid }) => {
      await hb.validateChild(child_uid);

      const timer = await hb.getTimer("sleep", child_uid);
      if (!timer?.active) {
        return ok({
          success: false,
          message: "Sleep is not active; ignoring pause request",
        });
      }
      if (timer.paused) {
        return ok({ success: false, message: "Sleep is already paused" });
      }

      const now = hb.nowSec();

      await hb.db.updateDoc(`sleep/${child_uid}`, {
        "timer.paused": true,
        "timer.active": true,
        "timer.timerEndTime": dbl(now * 1000),
        "timer.timestamp": { seconds: dbl(now) },
        "timer.local_timestamp": dbl(now),
      });

      return ok({
        success: true,
        message: `Sleep tracking paused for child ${child_uid}`,
        timestamp: timestampToLocalIso(now, hb.tz),
      });
    },
  );

  server.registerTool(
    "resume_sleep",
    {
      description: "Resume a paused sleep tracking session.",
      inputSchema: z.object({ child_uid: z.string() }),
    },
    async ({ child_uid }) => {
      await hb.validateChild(child_uid);

      const timer = await hb.getTimer("sleep", child_uid);
      if (!timer?.active) {
        return ok({
          success: false,
          message: "Sleep is not active; ignoring resume request",
        });
      }
      if (!timer.paused) {
        return ok({ success: false, message: "Sleep is not paused" });
      }

      const now = hb.nowSec();

      await hb.db.updateDoc(`sleep/${child_uid}`, {
        "timer.paused": false,
        "timer.active": true,
        "timer.timestamp": { seconds: dbl(now) },
        "timer.local_timestamp": dbl(now),
      });

      return ok({
        success: true,
        message: `Sleep tracking resumed for child ${child_uid}`,
        timestamp: timestampToLocalIso(now, hb.tz),
      });
    },
  );

  server.registerTool(
    "complete_sleep",
    {
      description:
        "Complete the active sleep session and save it to the child's history.",
      inputSchema: z.object({ child_uid: z.string() }),
    },
    async ({ child_uid }) => {
      await hb.validateChild(child_uid);

      const timer = await hb.getTimer("sleep", child_uid);
      if (!timer?.active) {
        return ok({
          success: false,
          message: "Sleep already completed; ignoring duplicate request",
        });
      }

      let timerStartMs: number | undefined = timer.timerStartTime;
      if (!timerStartMs) {
        const seconds = timer.timestamp?.seconds;
        if (seconds) {
          timerStartMs = Number(seconds) * 1000;
        } else {
          await hb.db.updateDoc(`sleep/${child_uid}`, {
            timer: DELETE_FIELD,
          });
          throw new Error(
            "Missing timerStartTime; cannot compute sleep duration",
          );
        }
      }

      const now = hb.nowSec();
      const endMs =
        timer.paused && timer.timerEndTime != null
          ? Number(timer.timerEndTime)
          : now * 1000;

      const durationSec = Math.trunc((endMs - Number(timerStartMs)) / 1000);
      const startSec = Math.trunc(Number(timerStartMs) / 1000);

      const id = shortId();

      await hb.db.setDoc(`sleep/${child_uid}/intervals/${id}`, {
        _id: id,
        start: startSec,
        duration: durationSec,
        offset: hb.offset(),
        end_offset: hb.offset(),
        details: timer.details ?? emptySleepDetails(),
        lastUpdated: dbl(now),
      });

      await hb.db.updateDoc(`sleep/${child_uid}`, {
        timer: {
          active: false,
          paused: false,
          timestamp: { seconds: dbl(now) },
          timerStartTime: null,
          uuid: timer.uuid ?? shortId(),
          local_timestamp: dbl(now),
        },
        "prefs.lastSleep": {
          start: startSec,
          duration: durationSec,
          offset: hb.offset(),
        },
        "prefs.timestamp": { seconds: dbl(now) },
        "prefs.local_timestamp": dbl(now),
      });

      return ok({
        success: true,
        message: `Sleep tracking completed and saved for child ${child_uid}`,
        start_time: timestampToLocalIso(startSec, hb.tz),
        duration_minutes: Math.floor(durationSec / 60),
        interval_id: id,
        timestamp: timestampToLocalIso(now, hb.tz),
      });
    },
  );

  server.registerTool(
    "cancel_sleep",
    {
      description:
        "Cancel the active sleep session and discard it (nothing is saved to history).",
      inputSchema: z.object({ child_uid: z.string() }),
    },
    async ({ child_uid }) => {
      await hb.validateChild(child_uid);

      const timer = await hb.getTimer("sleep", child_uid);
      const now = hb.nowSec();

      await hb.db.updateDoc(`sleep/${child_uid}`, {
        timer: {
          active: false,
          paused: false,
          timestamp: { seconds: dbl(now) },
          timerStartTime: null,
          uuid: timer?.uuid ?? shortId(),
          local_timestamp: dbl(now),
        },
      });

      return ok({
        success: true,
        message: `Sleep tracking cancelled for child ${child_uid}`,
        timestamp: timestampToLocalIso(now, hb.tz),
      });
    },
  );

  server.registerTool(
    "get_sleep_history",
    {
      description:
        "Get sleep history for a child. Dates are YYYY-MM-DD and inclusive on both ends; " +
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
        "sleep",
        child_uid,
        "intervals",
        start,
        end,
      );

      const result = intervals.map((i) => {
        const startTs = i.start as number;
        const duration = (i.duration as number) ?? 0;

        return {
          interval_id: i.__id,
          start_time: timestampToLocalIso(startTs, hb.tz),
          // The Python server looked for an `end` field the backend never
          // writes, so end_time was always null. It is derived here.
          end_time: duration
            ? timestampToLocalIso(startTs + duration, hb.tz)
            : null,
          duration_minutes: Math.floor(duration / 60),
        };
      });

      return ok(result);
    },
  );
}
