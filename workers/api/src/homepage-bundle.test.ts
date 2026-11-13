import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './env';
import api from './index';
import { publicRoute } from './routes/public';
import { D1_BOOKMARK_HEADER } from './session';

let currentGeneration = 1;
let generationRead: (() => Promise<number>) | undefined;
vi.mock('./db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./db')>();
  return {
    ...actual,
    publicCacheGenerationFresh: async () => (generationRead ? generationRead() : currentGeneration),
  };
});

const { homepageBundle, warmHomepageBundle } = await import('./homepage-bundle');
const key = 'public/homepage/v1/current-bundle.json';

function payload(path: string): unknown {
  if (path.includes('/people?')) {
    return { people: [] };
  }
  if (path.includes('/search')) {
    return { claims: [] };
  }
  if (path.includes('/recommendation-groups?')) {
    return { groups: [] };
  }
  if (path.includes('/sources?')) {
    return { sources: [] };
  }
  return { people: 0, episodes: 0, publishedClaims: 0 };
}

function fixture(withSessions = false) {
  let stored: string | undefined;
  let uploaded = new Date();
  const get = vi.fn(async () =>
    stored === undefined ? null : { size: stored.length, uploaded, text: async () => stored }
  );
  const put = vi.fn(async (_key: string, text: string) => {
    stored = text;
    uploaded = new Date();
  });
  const anchors: Array<string | undefined> = [];
  const env = {
    DB: {
      withSession: (anchor?: string) => {
        anchors.push(anchor);
        const bookmark = `response-bookmark-${anchors.length}`;
        return { getBookmark: () => bookmark };
      },
    },
    RAW: { get, put },
    ENVIRONMENT: 'test',
  } as unknown as Env;
  const waits: Promise<unknown>[] = [];
  const executionCtx = {
    waitUntil: (promise: Promise<unknown>) => waits.push(promise),
  } as unknown as ExecutionContext;
  const app = withSessions ? api : new Hono<{ Bindings: Env }>();
  if (!withSessions) {
    app.get('/api/homepage-bundle', homepageBundle);
  }
  const request = (init?: RequestInit, bindings = env, background = true) =>
    app.request(
      'https://api.podcasts.highsignal.app/api/homepage-bundle',
      init,
      bindings,
      background ? executionCtx : undefined
    );
  return {
    env,
    anchors,
    get,
    put,
    request,
    waits,
    set: (value: unknown, ageMs = 0) => {
      stored = JSON.stringify(value);
      uploaded = new Date(Date.now() - ageMs);
    },
    setRaw: (text: string, ageMs = 0) => {
      stored = text;
      uploaded = new Date(Date.now() - ageMs);
    },
    stored: () => stored,
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function holdPublicRoutes(gate: Promise<void>) {
  return vi.spyOn(publicRoute, 'request').mockImplementation(async (url) => {
    await gate;
    return Response.json(payload(String(url)));
  });
}

function bundle(generation = 1, ageMs = 0) {
  return {
    generation,
    capturedAt: new Date(Date.now() - ageMs).toISOString(),
    stats: payload('/stats'),
    people: payload('/people?limit=8'),
    evidence: payload('/search'),
    groups: payload('/recommendation-groups?limit=8'),
    sources: payload('/sources?limit=5'),
  };
}

afterEach(() => {
  currentGeneration = 1;
  generationRead = undefined;
  vi.restoreAllMocks();
});

describe('generation-validated homepage bundle', () => {
  it('does not start refresh work without a background execution context', async () => {
    const state = fixture();
    const cached = bundle(1, 6 * 60 * 1000);
    state.set(cached);
    const route = vi.spyOn(publicRoute, 'request');
    const response = await state.request(undefined, state.env, false);
    expect(await response.text()).toBe(JSON.stringify(cached));
    expect(route).not.toHaveBeenCalled();
    expect(state.put).not.toHaveBeenCalled();
    expect(state.waits).toHaveLength(0);
  });

  it('coalesces overlapping stale refreshes through the write without sharing responses or bookmarks', async () => {
    const state = fixture(true);
    const cached = bundle(1, 6 * 60 * 1000);
    state.set(cached);
    const routesReady = deferred();
    const writeReady = deferred();
    const route = holdPublicRoutes(routesReady.promise);
    const write = state.put.getMockImplementation();
    state.put.mockImplementation(async (objectKey, text) => {
      await writeReady.promise;
      await write?.(objectKey, text);
    });

    const responses = await Promise.all(Array.from({ length: 4 }, () => state.request()));
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(
      Array.from({ length: 4 }, () => JSON.stringify(cached))
    );
    expect(responses.map((response) => response.headers.get(D1_BOOKMARK_HEADER))).toEqual([
      'response-bookmark-1',
      'response-bookmark-2',
      'response-bookmark-3',
      'response-bookmark-4',
    ]);
    expect(state.anchors).toEqual(Array.from({ length: 4 }, () => 'first-unconstrained'));
    expect(route).toHaveBeenCalledTimes(5);
    expect(
      route.mock.calls.filter(([url]) =>
        /\/(stats|recommendation-groups)(?:\?|$)/u.test(String(url))
      )
    ).toHaveLength(2);
    routesReady.resolve();
    await vi.waitFor(() => expect(state.put).toHaveBeenCalledTimes(1));
    await state.request();
    expect(route).toHaveBeenCalledTimes(5);
    writeReady.resolve();
    await Promise.all(state.waits);
    expect(state.put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(state.stored() ?? '{}').capturedAt).not.toBe(cached.capturedAt);

    state.set(cached);
    await state.request();
    await Promise.all(state.waits);
    expect(route).toHaveBeenCalledTimes(10);
    expect(state.put).toHaveBeenCalledTimes(2);
  });

  it('keeps generations separate and cancels an older refresh after publication', async () => {
    const state = fixture();
    const gate = deferred();
    const route = holdPublicRoutes(gate.promise);
    state.set(bundle(1, 6 * 60 * 1000));
    await state.request();
    currentGeneration = 2;
    state.set(bundle(2, 6 * 60 * 1000));
    const response = await state.request();
    await expect(response.json()).resolves.toMatchObject({ generation: 2 });
    expect(route).toHaveBeenCalledTimes(10);
    gate.resolve();
    await Promise.all(state.waits);
    expect(state.put).toHaveBeenCalledTimes(1);
    expect(JSON.parse(state.stored() ?? '{}').generation).toBe(2);
  });

  it.each(['bucket', 'environment'])('isolates stale refreshes by %s', async (scope) => {
    const first = fixture();
    const second = fixture();
    first.set(bundle(1, 6 * 60 * 1000));
    second.set(bundle(1, 6 * 60 * 1000));
    const gate = deferred();
    const route = holdPublicRoutes(gate.promise);
    await first.request();
    await second.request(
      undefined,
      scope === 'environment'
        ? { ...second.env, RAW: first.env.RAW, ENVIRONMENT: 'another-environment' }
        : second.env
    );
    expect(route).toHaveBeenCalledTimes(10);
    gate.resolve();
    await Promise.all([...first.waits, ...second.waits]);
    expect(first.put.mock.calls.length + second.put.mock.calls.length).toBe(2);
  });

  it.each(['route', 'write'])(
    'retries after a failed %s without retaining a rejected refresh',
    async (stage) => {
      const state = fixture();
      state.set(bundle(1, 6 * 60 * 1000));
      const gate = deferred();
      let fail = true;
      const route = vi.spyOn(publicRoute, 'request').mockImplementation(async (url) => {
        await gate.promise;
        if (stage === 'route' && fail) {
          throw new Error('synthetic route failure');
        }
        return Response.json(payload(String(url)));
      });
      if (stage === 'write') {
        state.put.mockRejectedValueOnce(new Error('synthetic R2 failure'));
      }
      await Promise.all(Array.from({ length: 4 }, () => state.request()));
      expect(route).toHaveBeenCalledTimes(5);
      gate.resolve();
      await Promise.all(state.waits);
      fail = false;
      await state.request();
      await Promise.all(state.waits);
      expect(route).toHaveBeenCalledTimes(10);
      expect(JSON.parse(state.stored() ?? '{}').generation).toBe(1);
      expect(state.put).toHaveBeenCalledTimes(stage === 'route' ? 1 : 2);
    }
  );

  it('bypasses coalescing for explicit bookmarks and retains every request session', async () => {
    const state = fixture(true);
    const cached = bundle(1, 6 * 60 * 1000);
    state.set(cached);
    const gate = deferred();
    const route = holdPublicRoutes(gate.promise);
    const bookmarks = ['client-1', 'client-2', 'client-3', 'client-4'];
    const responses = await Promise.all(
      bookmarks.map((bookmark) => state.request({ headers: { [D1_BOOKMARK_HEADER]: bookmark } }))
    );
    expect(state.anchors).toEqual(bookmarks);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(
      bookmarks.map(() => JSON.stringify(cached))
    );
    expect(responses.map((response) => response.headers.get(D1_BOOKMARK_HEADER))).toEqual([
      'response-bookmark-1',
      'response-bookmark-2',
      'response-bookmark-3',
      'response-bookmark-4',
    ]);
    expect(route).toHaveBeenCalledTimes(20);
    gate.resolve();
    await Promise.all(state.waits);
    expect(state.put).toHaveBeenCalledTimes(4);
  });

  it('leaves overlapping cold rebuilds and direct warmers independent', async () => {
    const state = fixture();
    const gate = deferred();
    const route = holdPublicRoutes(gate.promise);
    const responses = Array.from({ length: 4 }, () => state.request());
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(20));
    gate.resolve();
    expect((await Promise.all(responses)).map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
    await Promise.all(state.waits);
    expect(state.put).toHaveBeenCalledTimes(4);
    await Promise.all([warmHomepageBundle(state.env), warmHomepageBundle(state.env)]);
    expect(route).toHaveBeenCalledTimes(30);
    expect(state.put).toHaveBeenCalledTimes(6);
  });

  it('starts the generation and R2 reads together on a cold request', async () => {
    const fixtureState = fixture();
    fixtureState.set(bundle());
    let resolveGeneration: ((value: number) => void) | undefined;
    generationRead = () =>
      new Promise<number>((resolve) => {
        resolveGeneration = resolve;
      });
    const response = fixtureState.request();
    await vi.waitFor(() => expect(fixtureState.get).toHaveBeenCalledTimes(1));
    resolveGeneration?.(1);
    expect((await response).status).toBe(200);
  });

  it('serves the complete matching copy without calling public routes', async () => {
    const fixtureState = fixture();
    fixtureState.set(bundle());
    const route = vi.spyOn(publicRoute, 'request');
    const response = await fixtureState.request();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({ generation: 1, people: { people: [] } });
    expect(route).not.toHaveBeenCalled();
  });

  it('rejects an old generation and rebuilds from the gated public routes', async () => {
    const fixtureState = fixture();
    fixtureState.set(bundle(1));
    currentGeneration = 2;
    const route = vi
      .spyOn(publicRoute, 'request')
      .mockImplementation(async (url) => Response.json(payload(String(url))));
    const response = await fixtureState.request();
    await expect(response.json()).resolves.toMatchObject({ generation: 2 });
    expect(route).toHaveBeenCalledTimes(5);
    await Promise.all(fixtureState.waits);
    expect(JSON.parse(fixtureState.stored() ?? '{}').generation).toBe(2);
    expect(fixtureState.put).toHaveBeenCalledWith(key, expect.any(String), expect.any(Object));
  });

  it.each([
    ['missing', undefined, 0],
    ['malformed', '{bad JSON', 0],
    ['partial', JSON.stringify({ generation: 1, people: { people: [] } }), 0],
    ['expired', JSON.stringify(bundle(1, 25 * 60 * 60 * 1000)), 25 * 60 * 60 * 1000],
  ])(
    'fails closed when the %s copy and public fallback are unavailable',
    async (_name, text, age) => {
      const fixtureState = fixture();
      if (text !== undefined) {
        fixtureState.setRaw(text, Number(age));
      }
      vi.spyOn(publicRoute, 'request').mockResolvedValue(
        new Response('unavailable', { status: 503 })
      );
      const response = await fixtureState.request();
      expect(response.status).toBe(503);
      expect(fixtureState.put).not.toHaveBeenCalled();
    }
  );

  it('refreshes a five-minute copy without extending the 24-hour hard age', async () => {
    const fixtureState = fixture();
    fixtureState.set(bundle(1, 6 * 60 * 1000), 6 * 60 * 1000);
    const route = vi
      .spyOn(publicRoute, 'request')
      .mockImplementation(async (url) => Response.json(payload(String(url))));
    const response = await fixtureState.request();
    expect(response.status).toBe(200);
    await Promise.all(fixtureState.waits);
    expect(route).toHaveBeenCalledTimes(5);
    expect(JSON.parse(fixtureState.stored() ?? '{}').capturedAt).not.toBe(
      bundle(1, 6 * 60 * 1000).capturedAt
    );
  });

  it('never publishes a partial response from the public routes', async () => {
    const fixtureState = fixture();
    vi.spyOn(publicRoute, 'request').mockImplementation(async (url) =>
      Response.json(String(url).includes('/sources?') ? { sources: [{}] } : payload(String(url)))
    );
    const response = await fixtureState.request();
    expect(response.status).toBe(503);
    expect(fixtureState.put).not.toHaveBeenCalled();
  });

  it('does not let a late older warm overwrite a newer publication', async () => {
    const fixtureState = fixture();
    let resumeOld: (() => void) | undefined;
    let oldStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      oldStarted = resolve;
    });
    const oldWait = new Promise<void>((resolve) => {
      resumeOld = resolve;
    });
    vi.spyOn(publicRoute, 'request').mockImplementation(async (url) => {
      if (currentGeneration === 1) {
        oldStarted?.();
        await oldWait;
      }
      return Response.json(payload(String(url)));
    });
    const oldWarm = warmHomepageBundle(fixtureState.env);
    await started;
    currentGeneration = 2;
    await warmHomepageBundle(fixtureState.env);
    resumeOld?.();
    await oldWarm;
    expect(JSON.parse(fixtureState.stored() ?? '{}').generation).toBe(2);
  });

  it('rejects an older write that completes after a newer bundle write', async () => {
    const fixtureState = fixture();
    const originalPut = fixtureState.put.getMockImplementation();
    let releaseOldPut: (() => void) | undefined;
    let oldPutStarted: (() => void) | undefined;
    const oldPutWait = new Promise<void>((resolve) => {
      releaseOldPut = resolve;
    });
    const oldPutEntered = new Promise<void>((resolve) => {
      oldPutStarted = resolve;
    });
    fixtureState.put.mockImplementation(async (objectKey, text) => {
      if (JSON.parse(text).generation === 1) {
        oldPutStarted?.();
        await oldPutWait;
      }
      await originalPut?.(objectKey, text);
    });
    vi.spyOn(publicRoute, 'request').mockImplementation(async (url) =>
      Response.json(payload(String(url)))
    );
    const oldWarm = warmHomepageBundle(fixtureState.env);
    await oldPutEntered;
    currentGeneration = 2;
    await warmHomepageBundle(fixtureState.env);
    releaseOldPut?.();
    await oldWarm;
    expect(JSON.parse(fixtureState.stored() ?? '{}').generation).toBe(1);

    const response = await fixtureState.request();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ generation: 2 });
  });
});
