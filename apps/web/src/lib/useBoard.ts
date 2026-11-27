import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlatSpan } from '@alibi/core';
import { connectLive, type Live } from './liveSource';
import type { Params } from './params';
import { ReplayClient } from './replayClient';
import { findRun, loadIndex, loadSummary, runFileUrl, type RunIndex, type RunSummary } from './runs';
import { applySnapshot, boardFrom, type Board, type Moment, type Snapshot } from './viewModel';

export type Mode = 'starting' | 'finished' | 'loading' | 'playing' | 'paused' | 'failed';

export interface Controller {
  mode: Mode;
  board?: Board;
  index?: RunIndex;
  /** Every notable moment of the whole run, for the jump chips. */
  moments: Moment[];
  featured?: RunSummary['featured'];
  speed: number;
  /** While a run file arrives: bytes so far and in all. */
  progress?: { loaded: number; total: number };
  source: 'replay' | 'live' | 'live-down';
  selectRun(name: string): void;
  play(): void;
  pause(): void;
  setSpeed(speed: number): void;
  seek(atMs: number): void;
  jump(moment: Moment): void;
  trace(id: string): Promise<FlatSpan[]>;
  warm(): void;
}

const DEFAULT_SPEED = 8;

export function useBoard(params: Params): Controller {
  const [mode, setMode] = useState<Mode>('starting');
  const [board, setBoard] = useState<Board>();
  const [index, setIndex] = useState<RunIndex>();
  const [summary, setSummary] = useState<RunSummary>();
  const [speed, setSpeedState] = useState(params.speed ?? DEFAULT_SPEED);
  const [source, setSource] = useState<Controller['source']>('replay');
  const [progress, setProgress] = useState<{ loaded: number; total: number }>();
  const speedTouched = useRef(false);
  const sizeOf = useRef(0);
  const indexRef = useRef<RunIndex | undefined>(undefined);

  const client = useRef<ReplayClient | undefined>(undefined);
  const loaded = useRef<Promise<void> | undefined>(undefined);
  const loadedKey = useRef('');
  const live = useRef<Live | undefined>(undefined);
  const needsReset = useRef(true);
  const target = useRef<number | undefined>(undefined);
  const busy = useRef(false);
  const playing = useRef(false);
  const clock = useRef(0);
  const speedRef = useRef(speed);
  const endMs = useRef(0);
  const boardRef = useRef<Board | undefined>(undefined);
  const summaryRef = useRef<RunSummary | undefined>(undefined);
  const dropAnswers = useRef(false);
  const liveOn = useRef(false);
  boardRef.current = board;
  summaryRef.current = summary;

  const show = useCallback((b: Board) => {
    boardRef.current = b;
    setBoard(b);
  }, []);

  const applyFromWorker = useCallback(
    (snapshot: Snapshot) => {
      const current = boardRef.current;
      const meta = summaryRef.current?.meta ?? current?.meta;
      if (!meta) return;
      const reset = needsReset.current || snapshot.reset;
      needsReset.current = false;
      const next = reset || !current ? boardFrom(meta, { ...snapshot, reset: true }) : applySnapshot(current, snapshot);
      show(next);
    },
    [show],
  );

  const pump = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      while (target.current !== undefined && client.current) {
        const t = target.current;
        target.current = undefined;
        applyFromWorker(await client.current.seek(t));
      }
    } finally {
      busy.current = false;
    }
  }, [applyFromWorker]);

  const request = useCallback(
    (t: number) => {
      target.current = t;
      void pump();
    },
    [pump],
  );

  const ensureLoaded = useCallback(
    (name: string, drop = false): Promise<void> => {
      const key = `${name}|${drop}`;
      if (loaded.current && loadedKey.current === key) return loaded.current;
      client.current?.close();
      client.current = new ReplayClient();
      client.current.onProgress = (l, t) => setProgress({ loaded: l, total: t });
      loadedKey.current = key;
      needsReset.current = true;
      loaded.current = client.current.load(name, runFileUrl(name), drop, sizeOf.current).then(({ endMs: end }) => {
        endMs.current = end;
        setProgress(undefined);
      });
      return loaded.current;
    },
    [],
  );

  const stopClock = useCallback(() => {
    playing.current = false;
  }, []);

  const startClock = useCallback(() => {
    playing.current = true;
    let last = performance.now();
    const tick = (now: number): void => {
      if (!playing.current) return;
      clock.current = Math.min(endMs.current, clock.current + (now - last) * speedRef.current);
      last = now;
      request(clock.current);
      if (clock.current >= endMs.current) {
        playing.current = false;
        setMode('paused');
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, [request]);

  const openRun = useCallback(
    async (name: string, opts?: { drop?: boolean }) => {
      stopClock();
      target.current = undefined;
      const s = await loadSummary(name);
      summaryRef.current = s;
      setSummary(s);
      dropAnswers.current = opts?.drop ?? false;
      loaded.current = undefined;
      loadedKey.current = '';
      needsReset.current = true;
      endMs.current = s.snapshot.endMs;
      sizeOf.current = indexRef.current?.runs.find((r) => r.name === name)?.size ?? 0;
      clock.current = 0;
      // A long run plays faster by default, so watching it takes about half a minute, not a quarter of an hour.
      if (!params.speed && !speedTouched.current) {
        const auto = s.snapshot.endMs > 500_000 ? 30 : DEFAULT_SPEED;
        speedRef.current = auto;
        setSpeedState(auto);
      }
      if (!liveOn.current) {
        show(boardFrom(s.meta, s.snapshot));
        setMode('finished');
      }
      return s;
    },
    [show, stopClock],
  );

  const playFrom = useCallback(
    async (from?: number) => {
      const s = summaryRef.current;
      if (!s) return;
      setMode('loading');
      try {
        await ensureLoaded(s.meta.name, dropAnswers.current);
      } catch {
        setMode('failed');
        return;
      }
      const start = from ?? (clock.current >= endMs.current - 1 || boardRef.current?.nowMs === undefined ? 0 : clock.current);
      clock.current = start;
      needsReset.current = true;
      setMode('playing');
      startClock();
    },
    [ensureLoaded, startClock],
  );

  const seekTo = useCallback(
    async (atMs: number) => {
      const s = summaryRef.current;
      if (!s) return;
      stopClock();
      if (loadedKey.current !== `${s.meta.name}|${dropAnswers.current}`) {
        setMode('loading');
        try {
          await ensureLoaded(s.meta.name, dropAnswers.current);
        } catch {
          setMode('failed');
          return;
        }
      }
      clock.current = Math.max(0, Math.min(endMs.current, atMs));
      setMode('paused');
      request(clock.current);
    },
    [ensureLoaded, request, stopClock],
  );

  // First load: the index, the default run's summary, then whatever the address asks for.
  useEffect(() => {
    let cancelled = false;
    // One source per mode: a live board never loads a recorded run. The replay starts only when there is no live
    // guard to show, so nothing recorded can reach a live board.
    const startReplay = async (): Promise<void> => {
      try {
        const idx = await loadIndex();
        if (cancelled) return;
        indexRef.current = idx;
        setIndex(idx);
        const forced = params.state;
        let name = findRun(idx, params.run);
        if (forced === 'coupon') name = findRun(idx, 'coupon');
        if (forced === 'host') name = findRun(idx, 'host');
        if (forced === 'outage') name = findRun(idx, 'outage');
        if (forced === 'switching' || forced === 'unconfirmed' || forced === 'watching' || forced === 'labelled-feature' || forced === 'no-flagsmith-numbers') name = findRun(idx, 'coupon');
        if (forced === 'labelled-not-feature') name = findRun(idx, 'host');
        const s = await openRun(name, { drop: forced === 'unconfirmed' });
        if (cancelled) return;
        if (forced === 'no-flagsmith-numbers' && s.snapshot.record) {
          const { flagsmith: _drop, ...rest } = s.snapshot.record;
          void _drop;
          show(boardFrom(s.meta, { ...s.snapshot, record: rest }));
        }
        const at = (key: Moment['key']): number | undefined => s.snapshot.newMoments.find((m) => m.key === key)?.atMs;
        if (forced === 'armed') await seekTo(0);
        else if (forced === 'playing') {
          await playFrom(Math.floor(s.snapshot.endMs * 0.3));
        } else if (forced === 'paused') await seekTo(Math.floor(s.snapshot.endMs * 0.3));
        else if (forced === 'switching' || forced === 'unconfirmed') await seekTo((at('threshold') ?? 0) + 1);
        else if (forced === 'watching') await seekTo((at('switched-off') ?? 0) + 90_000);
        else if (params.t !== null && params.autoplay) await playFrom(params.t);
        else if (params.t !== null) await seekTo(params.t);
        else if (params.autoplay) await playFrom(0);
      } catch {
        if (!cancelled) setMode('failed');
      }
    };
    if (params.live && params.state !== 'live-down') {
      live.current = connectLive(
        params.live,
        (b) => {
          if (cancelled) return;
          liveOn.current = true;
          setSource('live');
          show(b);
          setMode('playing');
        },
        () => {
          if (cancelled || liveOn.current) return;
          setSource('live-down');
          void startReplay();
        },
      );
    } else {
      if (params.state === 'live-down') setSource('live-down');
      void startReplay();
    }
    return () => {
      cancelled = true;
      stopClock();
      live.current?.stop();
      client.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const moments = useMemo(() => summary?.snapshot.newMoments ?? [], [summary]);

  return {
    mode,
    ...(board ? { board } : {}),
    ...(index ? { index } : {}),
    moments,
    ...(summary?.featured ? { featured: summary.featured } : {}),
    speed,
    ...(progress ? { progress } : {}),
    source,
    selectRun: (name) => {
      void openRun(name).then(() => {
        const url = new URL(location.href);
        url.searchParams.set('run', name);
        url.searchParams.delete('t');
        history.replaceState(null, '', url);
      });
    },
    play: () => void playFrom(),
    pause: () => {
      stopClock();
      setMode('paused');
      const url = new URL(location.href);
      url.searchParams.set('t', String(Math.round(clock.current / 1000)));
      history.replaceState(null, '', url);
    },
    setSpeed: (n) => {
      speedTouched.current = true;
      speedRef.current = n;
      setSpeedState(n);
    },
    seek: (atMs) => void seekTo(atMs),
    jump: (moment) => void seekTo(moment.atMs),
    trace: async (id) => {
      if (live.current && source === 'live') return live.current.trace(id);
      const s = summaryRef.current;
      if (s?.featured?.id === id) return s.featured.spans;
      await ensureLoaded(s?.meta.name ?? '', dropAnswers.current);
      return client.current ? client.current.trace(id) : [];
    },
    warm: () => {
      const s = summaryRef.current;
      if (s && !loaded.current && !params.live) void ensureLoaded(s.meta.name, dropAnswers.current).catch(() => undefined);
    },
  };
}
