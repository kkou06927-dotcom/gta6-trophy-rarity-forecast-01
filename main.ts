// gta6-trophy-rarity-forecast-01 — entry: a refresh-aware earners model.
//
// What the page shows: each trophy's earn rate is earners / players_tracked, and both numbers only
// move when Exophase refreshes the game's counts. Reads between refreshes repeat the same state,
// so the history is first collapsed into refresh snapshots (a new snapshot whenever the tracked
// player count or any rate changes). On those snapshots the model works with counts, not rates:
//
//   earners E_i(k) = rate_i(k) / 100 * players(k)
//
// Players tracked grow fast at launch and then saturate, which a straight line in log-time fits
// well: ln P against u = ln(1 + hours since the first snapshot). Earners of one trophy follow the
// same shape — a power law in (1 + hours) — fitted per trophy by least squares on ln(E + 0.5);
// extrapolating in log-time is what damps it, because u grows ever slower in real time. The median
// rate at the target is then 100 * E_target / P_target, clamped so earners stay below the player
// count and the median cannot run away from the last observed rate.
//
// The spread sits on the logit scale around that median, like the scorer measures it. Its width
// grows with sqrt(horizon days) and with the trophy's own observed jumpiness: the diffusion of its
// logit rate between refreshes, estimated per trophy when the history has enough refreshes. A
// history with a single snapshot has never shown a refresh — the one event that moved every rate
// at launch — so those trophies get an extra width premium instead of false confidence. Trophies
// whose history is too thin to fit fall back to their last rate with the same spread machinery.
//
// Deterministic: only the case file's own timestamps are read, no clock, no randomness.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const HOUR_MS = 3_600_000;

interface TrophyMeta {
  id: number;
  tier: string;
}

interface Read {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
}

interface CaseFile {
  id: string;
  at: string;
  target: string;
  horizon_minutes: number;
  levels: number[];
  trophies: TrophyMeta[];
  history: Read[];
}

interface Snapshot {
  hours: number; // hours since the first snapshot
  players: number;
  rates: Array<number | null>;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
/** The scorer's clamp before the logit: the page prints 2 decimals, 0 and 100 have no logit. */
const clampRate = (pct: number): number => clamp(pct, 0.01, 99.99);
const logit = (pct: number): number => {
  const p = clampRate(pct) / 100;
  return Math.log(p / (1 - p));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-clamp(l, -16, 16)));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Least squares y ~ a + b*x; returns null when x has no spread. */
function fitLine(xs: number[], ys: number[]): { a: number; b: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 1e-12) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

/** Collapse the read history into refresh snapshots: a new one when anything on the page moved. */
function snapshots(history: Read[]): Snapshot[] {
  const out: Snapshot[] = [];
  let t0 = 0;
  for (const r of history) {
    const t = Date.parse(r.at);
    if (!Number.isFinite(t)) continue; // an unreadable timestamp would poison every hour count
    const prev = out[out.length - 1];
    const moved =
      prev === undefined ||
      prev.players !== r.players_tracked ||
      r.rates.some((v, i) => v !== prev.rates[i]);
    if (moved) {
      if (out.length === 0) t0 = t;
      out.push({ hours: (t - t0) / HOUR_MS, players: r.players_tracked, rates: r.rates });
    }
  }
  return out;
}

/** Forecast the tracked player count at u_target (log-time of the target). */
function forecastPlayers(snaps: Snapshot[], uTarget: number, days: number): number {
  const last = snaps[snaps.length - 1];
  if (snaps.length < 2) {
    // No refresh observed: the count will grow, by an amount nobody can read off one snapshot.
    return last.players * clamp(1 + days, 1, 8);
  }
  const fit = fitLine(
    snaps.map((s) => Math.log(1 + s.hours)),
    snaps.map((s) => Math.log(Math.max(1, s.players))),
  );
  if (fit === null) return last.players * 1.5;
  const b = clamp(fit.b, 0, 1.5);
  const p = Math.exp(fit.a + b * uTarget);
  return clamp(p, last.players, last.players * 40);
}

/** Per-trophy logit diffusion per sqrt-day, from the jumps between refreshes; null when too few. */
function diffusion(snaps: Snapshot[], idx: number): number | null {
  const diffs: number[] = [];
  for (let k = 1; k < snaps.length; k++) {
    const r0 = snaps[k - 1].rates[idx];
    const r1 = snaps[k].rates[idx];
    if (r0 === null || r1 === null) continue;
    const dtDays = Math.max((snaps[k].hours - snaps[k - 1].hours) / 24, 0.04);
    const d = logit(r1) - logit(r0);
    diffs.push((d * d) / dtDays);
  }
  if (diffs.length < 2) return null;
  const mean = diffs.reduce((s, x) => s + x, 0) / diffs.length;
  return Math.sqrt(mean);
}

function forecastTrophy(
  snaps: Snapshot[],
  idx: number,
  uTarget: number,
  pTarget: number,
  days: number,
): { median: number; sigma: number } {
  // This trophy's own refresh trajectory: (log-time, earners, rate) wherever the page listed it.
  const us: number[] = [];
  const es: number[] = [];
  let lastRate: number | null = null;
  let lastEarners = 0;
  for (const s of snaps) {
    const r = s.rates[idx];
    if (r === null) continue;
    us.push(Math.log(1 + s.hours));
    es.push((r / 100) * s.players);
    lastRate = r;
    lastEarners = (r / 100) * s.players;
  }

  const vol = diffusion(snaps, idx);
  const base = vol === null ? 0.95 : clamp(0.55 + 0.75 * vol, 0.55, 1.5);
  let sigma = base * Math.sqrt(days);
  if (snaps.length < 2) sigma += 0.85; // no refresh seen yet: the big unknown
  sigma = clamp(sigma, 0.3, 2.9);

  if (lastRate === null) {
    // Never listed with a rate: keep it rare and honestly unsure.
    return { median: 0.1, sigma: Math.max(sigma, 1.6) };
  }

  let eTarget: number | null = null;
  if (us.length >= 3) {
    const fit = fitLine(
      us,
      es.map((e) => Math.log(e + 0.5)),
    );
    if (fit !== null) {
      const b = clamp(fit.b, 0, 2.2);
      eTarget = Math.exp(fit.a + b * uTarget) - 0.5;
    }
  }
  if (eTarget === null || !Number.isFinite(eTarget)) {
    // Too thin to fit: the rate persists, so earners grow with the player count.
    eTarget = (lastRate / 100) * pTarget;
  }
  const capShare = lastRate > 99.9 ? 0.999 : 0.995;
  eTarget = clamp(eTarget, lastEarners * 0.85, pTarget * capShare);

  let median = (100 * eTarget) / pTarget;
  // The median may move with the week, but not without limit away from the last read.
  median = clamp(median, lastRate * 0.03, lastRate * 30 + 1.0);
  median = clamp(median, 0.02, 99.9);
  return { median, sigma };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR)
  .filter((f) => f.endsWith('.in'))
  .sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const days = c.horizon_minutes / 1440;
  const snaps = snapshots(c.history);
  const t0 = Date.parse(c.history[0].at);
  const uTarget = Math.log(1 + (Date.parse(c.target) - t0) / HOUR_MS);
  const pTarget = forecastPlayers(snaps, uTarget, days);
  const trophies = c.trophies.map((t, i) => {
    const { median, sigma } = forecastTrophy(snaps, i, uTarget, pTarget, days);
    const centre = logit(median);
    const q = Z.map((z) => round4(clamp(invLogit(centre + z * sigma), 0.001, 99.999)));
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { id: t.id, q };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
