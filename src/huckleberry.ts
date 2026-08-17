/**
 * Domain layer: the Huckleberry data model on top of the Firestore REST client.
 *
 * Collection layout, as used by the app:
 *   users/{userUid}                  -> { childList: [{ cid }] }
 *   childs/{childUid}                -> profile
 *   sleep/{childUid}                 -> { timer, prefs }, intervals/{id}
 *   feed/{childUid}                  -> { timer, prefs }, intervals/{id}
 *   diaper/{childUid}                -> { prefs },        intervals/{id}
 *   health/{childUid}                -> { prefs },        data/{id}
 *
 * Durations and timestamps in interval documents are seconds.
 */

import {
  DELETE_FIELD,
  Dbl,
  FirestoreClient,
  StructuredFilter,
  dbl,
  escapeFieldPathSegment,
} from "./firestore";
import { dateToTimestamp, endDateToTimestamp, offsetMinutes } from "./tz";

export { DELETE_FIELD, dbl, Dbl };

export interface Child {
  uid: string;
  name: string;
  birth_date: string | null;
}

export class Huckleberry {
  readonly db: FirestoreClient;

  constructor(
    email: string,
    password: string,
    readonly tz: string,
  ) {
    this.db = new FirestoreClient(email, password);
  }

  /** Timezone offset in the "positive west of UTC" form the app stores. */
  offset(at: Date = new Date()): Dbl {
    return dbl(offsetMinutes(this.tz, at));
  }

  nowSec(): number {
    return Date.now() / 1000;
  }

  // --- children -------------------------------------------------------------

  async getChildren(): Promise<Child[]> {
    await this.db.ensureAuth();

    const user = await this.db.getDoc(`users/${this.db.userUid}`);
    if (!user) return [];

    const childList = user.childList as Array<{ cid?: string }> | undefined;
    if (!Array.isArray(childList)) return [];

    const children: Child[] = [];

    for (const entry of childList) {
      const cid = entry?.cid;
      if (!cid) continue;

      const doc = await this.db.getDoc(`childs/${cid}`);
      if (!doc) continue;

      children.push({
        uid: cid,
        name:
          (doc.name as string) || (doc.childsName as string) || "Unknown",
        // The Python server read a `birthDate` key that the backend never
        // returns, so every child reported a null birth date.
        birth_date: (doc.birthdate as string) ?? null,
      });
    }

    return children;
  }

  async validateChild(childUid: string): Promise<void> {
    const children = await this.getChildren();
    const uids = children.map((c) => c.uid);

    if (!uids.includes(childUid)) {
      throw new Error(
        `Invalid child_uid '${childUid}'. Valid UIDs: ${uids.join(", ")}`,
      );
    }
  }

  // --- date ranges ----------------------------------------------------------

  /**
   * Resolve an optional YYYY-MM-DD range into a half-open [start, end) window
   * of Unix timestamps. `end_date` covers the whole day, so a single-day range
   * (start_date == end_date) returns that day's records.
   */
  resolveRange(
    startDate: string | undefined,
    endDate: string | undefined,
    defaultDays: number,
  ): { start: number; end: number } {
    const now = Date.now() / 1000;

    const start = startDate
      ? dateToTimestamp(startDate, this.tz)
      : Math.floor(now - defaultDays * 86400);

    const end = endDate ? endDateToTimestamp(endDate, this.tz) : Math.floor(now);

    return { start, end };
  }

  /**
   * Fetch interval documents in a time window.
   *
   * Records are stored two ways: ordinary documents with a top-level `start`,
   * and "multi" batch documents holding many entries under `data`, whose nested
   * starts cannot be filtered server-side. Both are collected, then merged and
   * sorted.
   */
  async getIntervals(
    collection: string,
    childUid: string,
    subcollection: string,
    start: number,
    end: number,
  ): Promise<Array<Record<string, unknown> & { __multi: boolean }>> {
    const parent = `${collection}/${childUid}`;
    const out: Array<Record<string, unknown> & { __multi: boolean }> = [];

    const rangeFilters: StructuredFilter[] = [
      { field: "start", op: "GREATER_THAN_OR_EQUAL", value: start },
      { field: "start", op: "LESS_THAN", value: end },
    ];

    const regular = await this.db.runQuery(
      parent,
      subcollection,
      rangeFilters,
      "start",
    );

    for (const doc of regular) {
      if (doc.multi) continue;
      out.push({ ...doc, __multi: false });
    }

    const multi = await this.db.runQuery(parent, subcollection, [
      { field: "multi", op: "EQUAL", value: true },
    ]);

    for (const doc of multi) {
      const data = doc.data;
      if (!data || typeof data !== "object") continue;

      for (const [key, entry] of Object.entries(
        data as Record<string, unknown>,
      )) {
        if (!entry || typeof entry !== "object") continue;

        const e = entry as Record<string, unknown>;
        const entryStart = e.start;
        if (typeof entryStart !== "number") continue;
        if (entryStart < start || entryStart >= end) continue;

        // A batched entry is addressed as "<documentId>#<entryKey>", since it
        // is a field inside a document rather than a document of its own.
        out.push({
          ...e,
          __id: `${doc.__id}#${key}`,
          __multi: true,
        });
      }
    }

    out.sort(
      (a, b) => ((a.start as number) ?? 0) - ((b.start as number) ?? 0),
    );

    return out;
  }

  // --- timer state ----------------------------------------------------------

  /** Read the `timer` map from a tracker document. */
  async getTimer(
    collection: string,
    childUid: string,
  ): Promise<Record<string, any> | null> {
    const doc = await this.db.getDoc(`${collection}/${childUid}`);
    if (!doc) return null;
    return (doc.timer as Record<string, any>) ?? {};
  }

  // --- deletion -------------------------------------------------------------

  /**
   * Permanently remove one record.
   *
   * `recordId` is the `interval_id` reported by the history tools. A batched
   * entry carries the composite form "<documentId>#<entryKey>" and is removed
   * as a field of its parent document rather than as a document.
   */
  async deleteRecord(
    type: TrackerType,
    childUid: string,
    recordId: string,
  ): Promise<void> {
    const { collection, sub } = TRACKERS[type];

    if (recordId.includes("#")) {
      const [docId, entryKey] = recordId.split("#");
      await this.db.updateDoc(`${collection}/${childUid}/${sub}/${docId}`, {
        [`data.${escapeFieldPathSegment(entryKey)}`]: DELETE_FIELD,
      });
    } else {
      await this.db.deleteDoc(`${collection}/${childUid}/${sub}/${recordId}`);
    }

    await this.refreshLastPointer(type, childUid);
  }

  /**
   * Repoint `prefs.last*` at the newest surviving record.
   *
   * The app reads these fields directly, so deleting the most recent record
   * without repointing leaves it displaying a record that no longer exists.
   * Batched entries carry no top-level `start` and so cannot win this query;
   * the pointer is a convenience, not the source of truth.
   */
  private async refreshLastPointer(
    type: TrackerType,
    childUid: string,
  ): Promise<void> {
    const { collection, sub } = TRACKERS[type];

    const newest = await this.db.runQuery(
      `${collection}/${childUid}`,
      sub,
      [],
      "start",
      { direction: "DESCENDING", limit: 1 },
    );

    const last = newest[0];
    if (!last) return;

    const path = `${collection}/${childUid}`;
    const now = this.nowSec();
    const start = Number(last.start);
    const offset = dbl(Number(last.offset ?? offsetMinutes(this.tz)));

    const stamps = {
      "prefs.timestamp": { seconds: dbl(now) },
      "prefs.local_timestamp": dbl(now),
    };

    if (type === "sleep") {
      await this.db.updateDoc(path, {
        "prefs.lastSleep": {
          start,
          duration: Number(last.duration ?? 0),
          offset,
        },
        ...stamps,
      });
      return;
    }

    if (type === "diaper") {
      await this.db.updateDoc(path, {
        "prefs.lastDiaper": {
          start: dbl(start),
          mode: (last.mode as string) ?? "pee",
          offset,
        },
        ...stamps,
      });
      return;
    }

    if (type === "growth") {
      const { __id, ...entry } = last;
      await this.db.updateDoc(path, {
        "prefs.lastGrowthEntry": entry,
        ...stamps,
      });
      return;
    }

    // feed: bottle and nursing keep separate pointers.
    if (last.mode === "bottle") {
      await this.db.updateDoc(path, {
        "prefs.lastBottle": {
          mode: "bottle",
          start,
          amount: dbl(Number(last.amount ?? 0)),
          units: (last.units as string) ?? "oz",
          bottleType: (last.bottleType as string) ?? "Formula",
          offset,
        },
        ...stamps,
      });
      return;
    }

    const left = Number(last.leftDuration ?? 0);
    const right = Number(last.rightDuration ?? 0);

    await this.db.updateDoc(path, {
      "prefs.lastNursing": {
        mode: "breast",
        start,
        duration: dbl(left + right),
        leftDuration: dbl(left),
        rightDuration: dbl(right),
        offset,
      },
      "prefs.lastSide": {
        start,
        lastSide: (last.lastSide as string) ?? "left",
      },
      ...stamps,
    });
  }
}

/** Where each record type lives in Firestore. */
export const TRACKERS = {
  sleep: { collection: "sleep", sub: "intervals" },
  feed: { collection: "feed", sub: "intervals" },
  diaper: { collection: "diaper", sub: "intervals" },
  growth: { collection: "health", sub: "data" },
} as const;

export type TrackerType = keyof typeof TRACKERS;

/** The all-false detail checkboxes the app attaches to every sleep record. */
export function emptySleepDetails(): Record<string, unknown> {
  return {
    startSleepCondition: {
      happy: false,
      longTimeToFallAsleep: false,
      "10-20_minutes": false,
      upset: false,
      under_10_minutes: false,
    },
    sleepLocations: {
      car: false,
      nursing: false,
      wornOrHeld: false,
      stroller: false,
      coSleep: false,
      nextToCarer: false,
      onOwnInBed: false,
      bottle: false,
      swing: false,
    },
    endSleepCondition: {
      happy: false,
      wokeUpChild: false,
      upset: false,
    },
  };
}
