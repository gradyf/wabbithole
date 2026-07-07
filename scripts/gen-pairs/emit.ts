// Phase 3 flat-calendar emitter. Author-plane only (spec §2.1) — never runs in
// `vercel build`. Materializes src/race/pairs.json (the flat calendar the
// runtime selects from) and src/race/pairs.meta.json (a provenance sidecar the
// app never imports).
//
// THE HISTORY-PRESERVATION RULE (spec §2.4 — the one correctness trap). Switching
// pairForKey from a wrapping mod-120 rotation to a flat CALENDAR[dayIndex] index
// would, done naively, change the pair for every already-elapsed date (day ≥120)
// and corrupt syncAccount's historical title reconstruction. So the emitter
// MATERIALIZES the legacy rotation into the historical prefix: every slot i below
// the cutover is exactly legacy[i mod 120] — reproducing what the old scheme
// returned for that date. Only slots at/after the cutover carry freshly-validated
// pairs. In THIS phase the validated list is EMPTY, so the whole horizon is the
// legacy materialization and the emitted calendar is behaviorally identical to
// today's rotation for every date (proven by the full-horizon regression sweep in
// emit.test.ts). Phase 4 re-runs this same emitter with a real validated list +
// cutover; only DATA changes, and Gray hand-reviews that diff.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SAMPLER_SEED } from './rng.js';

export interface Pair {
  start: string; // canonical en title, UNDERSCORE form (pairs.json convention)
  target: string;
}

/** A validated pair as produced by the Phase 2 sampler/distance pipeline: titles
 *  are canonical SPACE form; the emitter converts them to underscore form
 *  (carried reviewer NOTE-1 from Task 22 — the emitter owns the conversion). The
 *  provenance fields ride into pairs.meta.json for validated slots. */
export interface ValidatedPair {
  start: string; // space form
  target: string; // space form
  distance: string; // verified distance, e.g. '>=3' | '4+'
  tier?: string;
  startBucket?: string;
  targetBucket?: string;
}

/** Day 0 of the calendar. MUST match src/race.ts EPOCH_UTC exactly. */
export const EMIT_EPOCH_UTC = Date.UTC(2026, 0, 1);

/** Calendar length for this phase: ~550 slots, through mid-2027 (Decision 2
 *  sizing: cutover + ~365 of daily uniqueness). A named constant so any re-emit
 *  is a deliberate, reviewable bump. */
export const HORIZON = 555;

/** The last calendar day must stay at least this many days ahead of the emit
 *  date, or the beyond-horizon xmur3 fallback would start firing for near dates.
 *  The emitter fails loudly below this so a stale horizon can never ship
 *  silently (spec §2.4). */
export const MIN_HORIZON_DAYS = 365;

const LEGACY_LEN = 120;

/** Space → underscore, the pairs.json / `titleEquals` win-check convention. */
export function toUnderscore(title: string): string {
  return title.replace(/ /g, '_');
}

/** dayIndex of the emit date, mirroring src/race.ts dayIndex/dayKey (local Y-M-D
 *  through Date.UTC so it is timezone/DST-immune). Drives the freshness assert. */
export function emitDayIndex(now: Date): number {
  return Math.floor(
    (Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - EMIT_EPOCH_UTC) / 86_400_000,
  );
}

export interface SlotMeta {
  i: number;
  origin: 'legacy' | 'validated';
  /** legacy: the mod-120 source index; validated: the validated-list index. */
  ref: number;
  /** validated slots only — carried from the Phase 2 distance verification. */
  distance?: string;
  tier?: string;
  startBucket?: string;
  targetBucket?: string;
}

export interface CalendarMeta {
  generatedAt: string;
  generator: string;
  epoch: string;
  horizon: number;
  cutover: number;
  legacySource: string;
  legacyLength: number;
  seed: string;
  note: string;
  counts: { legacySlots: number; validatedSlots: number };
  slots: SlotMeta[];
}

export interface BuildOpts {
  legacy: Pair[];
  validated: ValidatedPair[];
  /** Slot index where validated pairs begin; everything below it is legacy. */
  cutover: number;
  horizon: number;
  now: Date;
  seed?: string;
  minHorizonDays?: number;
  legacySource?: string;
}

/**
 * Pure calendar builder — no I/O, so fixtures drive every branch. Returns the
 * flat calendar (underscore-form pairs) and its provenance meta.
 */
export function buildCalendar(opts: BuildOpts): { calendar: Pair[]; meta: CalendarMeta } {
  const { legacy, validated, cutover, horizon, now } = opts;
  const seed = opts.seed ?? SAMPLER_SEED;
  const minHorizonDays = opts.minHorizonDays ?? MIN_HORIZON_DAYS;
  const legacySource = opts.legacySource ?? 'scripts/gen-pairs/data/legacy-pairs.json';

  // --- invariants (fail loudly; a bad calendar must never ship silently) ------
  if (legacy.length === 0) throw new Error('emit: legacy rotation is empty');
  if (horizon < 1) throw new Error(`emit: horizon must be >=1, got ${horizon}`);
  if (cutover < 0 || cutover > horizon) {
    throw new Error(`emit: cutover ${cutover} out of range [0, ${horizon}]`);
  }
  if (cutover + validated.length > horizon) {
    throw new Error(
      `emit: ${validated.length} validated pairs at cutover ${cutover} overflow horizon ${horizon}`,
    );
  }
  const todayIndex = emitDayIndex(now);
  const daysAhead = horizon - 1 - todayIndex;
  if (daysAhead < minHorizonDays) {
    throw new Error(
      `emit: horizon ${horizon} is only ${daysAhead} days ahead of emit date ` +
        `(dayIndex ${todayIndex}); need >= ${minHorizonDays}. Bump HORIZON and re-emit.`,
    );
  }

  const calendar: Pair[] = [];
  const slots: SlotMeta[] = [];
  for (let i = 0; i < horizon; i++) {
    const vIdx = i - cutover;
    if (i >= cutover && vIdx < validated.length) {
      const v = validated[vIdx];
      calendar.push({ start: toUnderscore(v.start), target: toUnderscore(v.target) });
      slots.push({
        i,
        origin: 'validated',
        ref: vIdx,
        distance: v.distance,
        tier: v.tier,
        startBucket: v.startBucket,
        targetBucket: v.targetBucket,
      });
    } else {
      const li = i % legacy.length; // i >= 0, so a plain mod suffices
      calendar.push(legacy[li]);
      slots.push({ i, origin: 'legacy', ref: li });
    }
  }

  const validatedSlots = slots.filter((s) => s.origin === 'validated').length;
  const meta: CalendarMeta = {
    generatedAt: now.toISOString(),
    generator: 'scripts/gen-pairs (Phase 3: flat-calendar emitter)',
    epoch: '2026-01-01',
    horizon,
    cutover,
    legacySource,
    legacyLength: legacy.length,
    seed,
    note:
      validatedSlots === 0
        ? 'Phase 3: validated list empty — entire horizon is the legacy materialization (CALENDAR[i] === legacy[i mod 120]); behaviorally identical to the pre-flat rotation for every date.'
        : `${validatedSlots} validated slots spliced from cutover ${cutover}; slots below cutover reproduce the legacy rotation exactly (history-preservation, spec §2.4).`,
    counts: { legacySlots: horizon - validatedSlots, validatedSlots },
    slots,
  };
  return { calendar, meta };
}

/** Exact byte format of the shipped pairs.json: one entry per line, 2-space
 *  indent, spaced braces — matching the committed convention so diffs stay clean
 *  and the legacy prefix is byte-identical to legacy-pairs.json's entries. */
export function serializeCalendar(calendar: Pair[]): string {
  const lines = calendar.map(
    (p) => `  { "start": ${JSON.stringify(p.start)}, "target": ${JSON.stringify(p.target)} }`,
  );
  return `[\n${lines.join(',\n')}\n]\n`;
}

export function serializeMeta(meta: CalendarMeta): string {
  return JSON.stringify(meta, null, 2) + '\n';
}

// --- CLI runner (author-plane; wired into index.ts as the `emit` subcommand) --

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, 'data');
const SRC_RACE_DIR = join(HERE, '..', '..', 'src', 'race');

function parseArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** The frozen legacy rotation — the permanent input for the historical prefix.
 *  A committed byte-for-byte copy of the pre-flat pairs.json (never the live
 *  pairs.json, which this emitter overwrites and so must never be its own source
 *  of history). */
function loadLegacy(): Pair[] {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'legacy-pairs.json'), 'utf8')) as Pair[];
  if (!Array.isArray(raw) || raw.length !== LEGACY_LEN) {
    throw new Error(
      `emit: legacy-pairs.json must be a ${LEGACY_LEN}-entry array, got ` +
        `${Array.isArray(raw) ? raw.length : typeof raw}`,
    );
  }
  return raw;
}

/** Optional validated input (Phase 4). Absent in Phase 3 → empty list, so the
 *  whole horizon is the legacy materialization. Accepts either a raw array or a
 *  `{ entries: [...] }` wrapper (matching the pool/quirky file convention). */
function loadValidated(): ValidatedPair[] {
  const path = join(DATA_DIR, 'validated.json');
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, 'utf8')) as ValidatedPair[] | { entries?: ValidatedPair[] };
  return Array.isArray(raw) ? raw : (raw.entries ?? []);
}

export async function runEmit(): Promise<void> {
  const now = new Date();
  const legacy = loadLegacy();
  const validated = loadValidated();

  // With an empty validated list (Phase 3) the cutover has no effect on output;
  // default it to HORIZON so `cutover === horizon` reads unambiguously as "no
  // validated region". Phase 4 supplies validated pairs and a real cutover.
  const cutoverArg = parseArg('--cutover');
  const cutover =
    cutoverArg !== undefined
      ? Number(cutoverArg)
      : validated.length > 0
        ? emitDayIndex(now) + 1
        : HORIZON;

  console.log(
    `gen-pairs Phase 3 emit — legacy ${legacy.length}, validated ${validated.length}, ` +
      `cutover ${cutover}, horizon ${HORIZON}, emit-day ${emitDayIndex(now)}`,
  );

  const { calendar, meta } = buildCalendar({ legacy, validated, cutover, horizon: HORIZON, now });

  mkdirSync(SRC_RACE_DIR, { recursive: true });
  const pairsPath = join(SRC_RACE_DIR, 'pairs.json');
  const metaPath = join(SRC_RACE_DIR, 'pairs.meta.json');
  writeFileSync(pairsPath, serializeCalendar(calendar));
  writeFileSync(metaPath, serializeMeta(meta));

  console.log(
    `emitted ${calendar.length} slots ` +
      `(legacy ${meta.counts.legacySlots}, validated ${meta.counts.validatedSlots})`,
  );
  console.log(`  ${pairsPath}`);
  console.log(`  ${metaPath}`);
  console.log(
    `horizon reaches dayIndex ${HORIZON - 1} (${meta.counts.validatedSlots === 0 ? 'all-legacy' : 'mixed'}); ` +
      `${HORIZON - 1 - emitDayIndex(now)} days ahead of emit date`,
  );
}
