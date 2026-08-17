/**
 * Firebase Auth + Firestore REST client.
 *
 * The Python client this port replaces used `google-cloud-firestore`, which
 * speaks gRPC and therefore cannot run on Workers. Every operation it performed
 * has a REST equivalent, which is what this module implements with plain
 * `fetch`.
 */

const FIREBASE_API_KEY = "AIzaSyApGVHktXeekGyAt-G6dIeWHUkq2oXqcjg";
const FIREBASE_PROJECT_ID = "simpleintervals";
const AUTH_URL =
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";
const REFRESH_URL = "https://securetoken.googleapis.com/v1/token";
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;

/** Marks a number that must be written as a Firestore double, not an integer. */
export class Dbl {
  constructor(readonly value: number) {}
}
export const dbl = (n: number) => new Dbl(n);

/** Marks a field that should be removed from the document. */
export const DELETE_FIELD = Symbol("DELETE_FIELD");

export type FieldValue = unknown;

// --- value codec ------------------------------------------------------------

function encodeValue(v: FieldValue): Record<string, unknown> {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Dbl) return { doubleValue: v.value };
  if (typeof v === "boolean") return { booleanValue: v };
  if (typeof v === "string") return { stringValue: v };

  if (typeof v === "number") {
    if (!Number.isFinite(v)) return { doubleValue: v };
    return Number.isInteger(v)
      ? { integerValue: String(v) }
      : { doubleValue: v };
  }

  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(encodeValue) } };
  }

  if (typeof v === "object") {
    return { mapValue: { fields: encodeFields(v as Record<string, unknown>) } };
  }

  throw new Error(`Cannot encode value of type ${typeof v}`);
}

export function encodeFields(
  obj: Record<string, FieldValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = encodeValue(v);
  return out;
}

function decodeValue(v: Record<string, any>): unknown {
  if (v === null || v === undefined) return null;
  if ("nullValue" in v) return null;
  if ("booleanValue" in v) return v.booleanValue;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("timestampValue" in v) return v.timestampValue;
  if ("bytesValue" in v) return v.bytesValue;
  if ("referenceValue" in v) return v.referenceValue;
  if ("geoPointValue" in v) return v.geoPointValue;
  if ("arrayValue" in v) {
    return (v.arrayValue.values ?? []).map(decodeValue);
  }
  if ("mapValue" in v) {
    return decodeFields(v.mapValue.fields ?? {});
  }
  return null;
}

export function decodeFields(
  fields: Record<string, any>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

/**
 * Expand dotted update paths ("timer.paused") into the nested document body
 * Firestore expects, dropping any path marked for deletion. A deleted path is
 * still listed in the update mask, which is how the REST API spells
 * DELETE_FIELD.
 */
function buildNestedFields(
  updates: Record<string, FieldValue | typeof DELETE_FIELD>,
): Record<string, unknown> {
  const root: Record<string, any> = {};

  for (const [path, value] of Object.entries(updates)) {
    if (value === DELETE_FIELD) continue;

    const segments = path.split(".");
    let cursor = root;

    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!(seg in cursor)) cursor[seg] = {};
      cursor = cursor[seg];
    }
    cursor[segments[segments.length - 1]] = value;
  }

  return encodeFields(root);
}

// --- client -----------------------------------------------------------------

export interface StructuredFilter {
  field: string;
  op:
    | "LESS_THAN"
    | "LESS_THAN_OR_EQUAL"
    | "GREATER_THAN"
    | "GREATER_THAN_OR_EQUAL"
    | "EQUAL";
  value: FieldValue;
}

interface CachedSession {
  idToken: string;
  refreshToken: string;
  userUid: string;
  expiresAt: number;
}

/**
 * Best-effort token cache, shared by requests that happen to land on the same
 * isolate. Firebase ID tokens last an hour; re-authenticating on a cold isolate
 * costs one extra round trip.
 */
let sessionCache: (CachedSession & { key: string }) | null = null;

export class FirestoreClient {
  private idToken: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt = 0;
  userUid: string | null = null;

  constructor(
    private readonly email: string,
    private readonly password: string,
  ) {}

  private get cacheKey(): string {
    return this.email;
  }

  private async authenticate(): Promise<void> {
    const res = await fetch(`${AUTH_URL}?key=${FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: this.email,
        password: this.password,
        returnSecureToken: true,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Huckleberry authentication failed (${res.status}): ${body}`,
      );
    }

    const data = (await res.json()) as {
      idToken: string;
      refreshToken: string;
      localId: string;
      expiresIn: string;
    };

    this.idToken = data.idToken;
    this.refreshToken = data.refreshToken;
    this.userUid = data.localId;
    this.expiresAt = Date.now() / 1000 + Number(data.expiresIn);

    sessionCache = {
      key: this.cacheKey,
      idToken: this.idToken,
      refreshToken: this.refreshToken,
      userUid: this.userUid,
      expiresAt: this.expiresAt,
    };
  }

  private async refresh(): Promise<void> {
    if (!this.refreshToken) return this.authenticate();

    const res = await fetch(`${REFRESH_URL}?key=${FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: this.refreshToken,
      }),
    });

    if (!res.ok) {
      // A rejected refresh token is recoverable: fall back to a full sign-in.
      sessionCache = null;
      return this.authenticate();
    }

    const data = (await res.json()) as {
      id_token: string;
      refresh_token: string;
      expires_in: string;
      user_id: string;
    };

    this.idToken = data.id_token;
    this.refreshToken = data.refresh_token;
    this.userUid = data.user_id ?? this.userUid;
    this.expiresAt = Date.now() / 1000 + Number(data.expires_in);

    sessionCache = {
      key: this.cacheKey,
      idToken: this.idToken,
      refreshToken: this.refreshToken,
      userUid: this.userUid!,
      expiresAt: this.expiresAt,
    };
  }

  async ensureAuth(): Promise<void> {
    if (!this.idToken && sessionCache?.key === this.cacheKey) {
      this.idToken = sessionCache.idToken;
      this.refreshToken = sessionCache.refreshToken;
      this.userUid = sessionCache.userUid;
      this.expiresAt = sessionCache.expiresAt;
    }

    if (!this.idToken) return this.authenticate();

    // Refresh while more than five minutes of life remain, as the app does.
    if (Date.now() / 1000 >= this.expiresAt - 300) return this.refresh();
  }

  private async request(
    url: string,
    init: RequestInit = {},
  ): Promise<Record<string, any>> {
    await this.ensureAuth();

    const res = await fetch(url, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        Authorization: `Bearer ${this.idToken}`,
        "Content-Type": "application/json",
      },
    });

    if (res.status === 401 || res.status === 403) {
      // Token rejected mid-flight: re-authenticate once and retry.
      sessionCache = null;
      this.idToken = null;
      await this.ensureAuth();

      const retry = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          Authorization: `Bearer ${this.idToken}`,
          "Content-Type": "application/json",
        },
      });
      if (!retry.ok) {
        throw new Error(
          `Firestore request failed (${retry.status}): ${await retry.text()}`,
        );
      }
      return (await retry.json()) as Record<string, any>;
    }

    if (!res.ok) {
      throw new Error(
        `Firestore request failed (${res.status}): ${await res.text()}`,
      );
    }

    return (await res.json()) as Record<string, any>;
  }

  /** Read a document. Returns null when it does not exist. */
  async getDoc(path: string): Promise<Record<string, unknown> | null> {
    await this.ensureAuth();

    const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
      headers: { Authorization: `Bearer ${this.idToken}` },
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(
        `Firestore get failed (${res.status}): ${await res.text()}`,
      );
    }

    const doc = (await res.json()) as { fields?: Record<string, any> };
    return decodeFields(doc.fields ?? {});
  }

  /**
   * Write a document, replacing it entirely — the REST equivalent of
   * `DocumentReference.set(data)`.
   */
  async setDoc(
    path: string,
    data: Record<string, FieldValue>,
  ): Promise<void> {
    await this.request(`${FIRESTORE_BASE}/${path}`, {
      method: "PATCH",
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
  }

  /**
   * Merge top-level fields into a document — the equivalent of
   * `set(data, merge=True)`.
   */
  async mergeDoc(
    path: string,
    data: Record<string, FieldValue>,
  ): Promise<void> {
    const mask = Object.keys(data)
      .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
      .join("&");

    await this.request(`${FIRESTORE_BASE}/${path}?${mask}`, {
      method: "PATCH",
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
  }

  /**
   * Apply targeted updates addressed by dotted field paths — the equivalent of
   * `DocumentReference.update({...})`, including DELETE_FIELD.
   */
  async updateDoc(
    path: string,
    updates: Record<string, FieldValue | typeof DELETE_FIELD>,
  ): Promise<void> {
    const mask = Object.keys(updates)
      .map((f) => `updateMask.fieldPaths=${encodeURIComponent(f)}`)
      .join("&");

    await this.request(`${FIRESTORE_BASE}/${path}?${mask}`, {
      method: "PATCH",
      body: JSON.stringify({ fields: buildNestedFields(updates) }),
    });
  }

  /**
   * Run a structured query against a subcollection of `parentPath`.
   */
  async runQuery(
    parentPath: string,
    collectionId: string,
    filters: StructuredFilter[],
    orderByField?: string,
    options: { direction?: "ASCENDING" | "DESCENDING"; limit?: number } = {},
  ): Promise<Record<string, unknown>[]> {
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId }],
    };

    if (options.limit != null) structuredQuery.limit = options.limit;

    if (filters.length === 1) {
      structuredQuery.where = {
        fieldFilter: {
          field: { fieldPath: filters[0].field },
          op: filters[0].op,
          value: encodeValue(filters[0].value),
        },
      };
    } else if (filters.length > 1) {
      structuredQuery.where = {
        compositeFilter: {
          op: "AND",
          filters: filters.map((f) => ({
            fieldFilter: {
              field: { fieldPath: f.field },
              op: f.op,
              value: encodeValue(f.value),
            },
          })),
        },
      };
    }

    if (orderByField) {
      structuredQuery.orderBy = [
        {
          field: { fieldPath: orderByField },
          direction: options.direction ?? "ASCENDING",
        },
      ];
    }

    await this.ensureAuth();

    const res = await fetch(`${FIRESTORE_BASE}/${parentPath}:runQuery`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ structuredQuery }),
    });

    if (!res.ok) {
      throw new Error(
        `Firestore query failed (${res.status}): ${await res.text()}`,
      );
    }

    const rows = (await res.json()) as Array<{
      document?: { name?: string; fields?: Record<string, any> };
    }>;

    return rows
      .filter((r) => r.document)
      .map((r) => ({
        __id: r.document!.name?.split("/").pop() ?? "",
        ...decodeFields(r.document!.fields ?? {}),
      }));
  }

  /** Permanently remove a document. */
  async deleteDoc(path: string): Promise<void> {
    await this.ensureAuth();

    const res = await fetch(`${FIRESTORE_BASE}/${path}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${this.idToken}` },
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(
        `Firestore delete failed (${res.status}): ${await res.text()}`,
      );
    }
  }
}

/**
 * Quote a field-path segment for an update mask. Firestore accepts bare
 * segments only when they look like identifiers; batch entry keys such as
 * "1786799661021-e949" start with a digit and must be backtick-quoted.
 */
export function escapeFieldPathSegment(segment: string): string {
  if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(segment)) return segment;
  return `\`${segment.replace(/[\\`]/g, (m) => `\\${m}`)}\``;
}

/** 16 hex characters, matching the id format the app generates. */
export function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

/** "<epoch-ms>-<20 hex>", the id format used for interval documents. */
export function intervalId(atMs: number = Date.now()): string {
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 20);
  return `${Math.floor(atMs)}-${rand}`;
}
