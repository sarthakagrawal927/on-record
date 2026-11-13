import type { Context } from 'hono';
import { publicCacheGenerationFresh } from './db';
import type { Env } from './env';
import { publicRoute } from './routes/public';
import { D1_BOOKMARK_HEADER } from './session';

const key = 'public/homepage/v1/current-bundle.json';
const maximumBytes = 512 * 1024;
const maximumAgeMs = 24 * 60 * 60 * 1000;
const refreshAfterMs = 5 * 60 * 1000;
const routes = {
  stats: '/stats',
  people: '/people?limit=8',
  evidence: '/search',
  groups: '/recommendation-groups?limit=8',
  sources: '/sources?limit=5',
} as const;

type Bundle = {
  generation: number;
  capturedAt: string;
  stats: unknown;
  people: unknown;
  evidence: unknown;
  groups: unknown;
  sources: unknown;
};

type PendingRefresh = { expiresAt: number; promise: Promise<void> };
const refreshSharingMs = 30_000;
const staleRefreshes = new WeakMap<R2Bucket, Map<string, PendingRefresh>>();

function refreshStaleBundle(env: Env, generation: number): Promise<void> {
  let pending = staleRefreshes.get(env.RAW);
  if (!pending) {
    pending = new Map();
    staleRefreshes.set(env.RAW, pending);
  }
  const now = Date.now();
  // A stopped request may leave its I/O unresolved. Expire sharing lazily,
  // including older generations, without changing response freshness limits.
  for (const [key, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(key);
    }
  }
  const identity = JSON.stringify([env.ENVIRONMENT ?? null, generation]);
  const existing = pending.get(identity);
  if (existing) {
    return existing.promise;
  }
  const refresh = publicCacheGenerationFresh(env.DB)
    .then(async (currentGeneration) => {
      if (currentGeneration !== generation) {
        return;
      }
      const bundle = await createBundle(env, generation);
      if (bundle) {
        await writeBundle(env, bundle);
      }
    })
    .finally(() => {
      if (pending.get(identity)?.promise === refresh) {
        pending.delete(identity);
      }
    });
  pending.set(identity, { expiresAt: now + refreshSharingMs, promise: refresh });
  return refresh;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isCount(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function validRows(
  value: unknown,
  name: string,
  maximum: number,
  validRow: (row: Record<string, unknown>) => boolean
): boolean {
  if (!(isRecord(value) && Array.isArray(value[name])) || value[name].length > maximum) {
    return false;
  }
  return value[name].every((row: unknown) => isRecord(row) && validRow(row));
}

function validStats(value: unknown): boolean {
  return (
    isRecord(value) &&
    isCount(value['people']) &&
    isCount(value['episodes']) &&
    isCount(value['publishedClaims'])
  );
}

function validPeople(value: unknown): boolean {
  return validRows(value, 'people', 8, (row) =>
    ['id', 'slug', 'name'].every((field) => isText(row[field]))
  );
}

function validEvidence(value: unknown): boolean {
  return validRows(
    value,
    'claims',
    50,
    (row) =>
      ['id', 'assertion', 'claimType', 'quote'].every((field) => isText(row[field])) &&
      row['reviewStatus'] === 'published' &&
      ['verified_speaker', 'speaker_unverified'].includes(String(row['attributionStatus']))
  );
}

function validGroups(value: unknown): boolean {
  return validRows(
    value,
    'groups',
    8,
    (row) =>
      isText(row['kind']) &&
      isText(row['name']) &&
      isCount(row['peopleCount']) &&
      isCount(row['occurrenceCount'])
  );
}

function validSources(value: unknown): boolean {
  return validRows(
    value,
    'sources',
    5,
    (row) => isText(row['id']) && isText(row['title']) && row['status'] === 'published'
  );
}

function validBundle(value: unknown): value is Bundle {
  if (!isRecord(value)) {
    return false;
  }
  return (
    Number.isSafeInteger(value['generation']) &&
    Number(value['generation']) > 0 &&
    typeof value['capturedAt'] === 'string' &&
    Number.isFinite(Date.parse(value['capturedAt'])) &&
    validStats(value['stats']) &&
    validPeople(value['people']) &&
    validEvidence(value['evidence']) &&
    validGroups(value['groups']) &&
    validSources(value['sources'])
  );
}

async function readBundle(bucket: R2Bucket): Promise<Bundle | undefined> {
  try {
    const object = await bucket.get(key);
    if (!object || object.size > maximumBytes) {
      return;
    }
    const text = await object.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      return;
    }
    const bundle: unknown = JSON.parse(text);
    if (!validBundle(bundle)) {
      return;
    }
    const age = Date.now() - Date.parse(bundle.capturedAt);
    const uploadAge = Date.now() - object.uploaded.getTime();
    if (age < 0 || age > maximumAgeMs || uploadAge < 0 || uploadAge > maximumAgeMs) {
      return;
    }
    return bundle;
  } catch {
    // A corrupt or unavailable copy never bypasses the public routes.
  }
}

async function createBundle(env: Env, generation: number): Promise<Bundle | undefined> {
  const entries = await Promise.all(
    Object.entries(routes).map(async ([name, path]) => {
      const response = await publicRoute.request(
        `https://api.podcasts.highsignal.app${path}`,
        undefined,
        env
      );
      if (!(response.ok && response.headers.get('content-type')?.includes('application/json'))) {
        throw new Error(`Homepage ${name} unavailable`);
      }
      return [name, await response.json()] as const;
    })
  );
  const bundle = {
    generation,
    capturedAt: new Date().toISOString(),
    ...Object.fromEntries(entries),
  };
  return validBundle(bundle) ? bundle : undefined;
}

async function writeBundle(env: Env, bundle: Bundle): Promise<boolean> {
  // A later publication may have begun while the gated routes were running.
  if ((await publicCacheGenerationFresh(env.DB)) !== bundle.generation) {
    return false;
  }
  const text = JSON.stringify(bundle);
  if (new TextEncoder().encode(text).byteLength > maximumBytes) {
    return false;
  }
  await env.RAW.put(key, text, { httpMetadata: { contentType: 'application/json' } });
  return true;
}

export async function homepageBundle(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (c.req.header('authorization') || c.req.header('cookie')) {
    return c.json({ error: 'anonymous_only' }, 400);
  }
  const [generation, cached] = await Promise.all([
    publicCacheGenerationFresh(c.env.DB),
    readBundle(c.env.RAW),
  ]);
  if (cached?.generation === generation) {
    const age = Date.now() - Date.parse(cached.capturedAt);
    if (age >= refreshAfterMs) {
      try {
        const executionCtx = c.executionCtx;
        // Only unbookmarked background refreshes share work. Foreground
        // responses and explicitly anchored sessions remain request-local.
        const refresh =
          c.req.header(D1_BOOKMARK_HEADER) === undefined
            ? refreshStaleBundle(c.env, generation)
            : warmHomepageBundle(c.env);
        executionCtx.waitUntil(refresh.catch(() => undefined));
      } catch {
        // The valid copy remains bounded even when no background context exists.
      }
    }
    return c.json(cached, 200, { 'cache-control': 'no-store' });
  }
  try {
    const fresh = await createBundle(c.env, generation);
    if (!fresh || (await publicCacheGenerationFresh(c.env.DB)) !== generation) {
      return c.json({ error: 'homepage_unavailable' }, 503);
    }
    try {
      c.executionCtx.waitUntil(writeBundle(c.env, fresh).catch(() => undefined));
    } catch {
      // A no-context runtime can still return the gated public response.
    }
    return c.json(fresh, 200, { 'cache-control': 'no-store' });
  } catch {
    return c.json({ error: 'homepage_unavailable' }, 503);
  }
}

export async function warmHomepageBundle(env: Env): Promise<Bundle | undefined> {
  const generation = await publicCacheGenerationFresh(env.DB);
  const bundle = await createBundle(env, generation);
  return bundle && (await writeBundle(env, bundle)) ? bundle : undefined;
}
