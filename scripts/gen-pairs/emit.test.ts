// Emitter + calendar fixture suite. Author-plane only, NOT wired into any npm
// script:
//
//   npx tsx scripts/gen-pairs/emit.test.ts
//
// Two things are tested:
//
//  1. THE SWEEP (load-bearing). CUTOVER-AWARE since the 2026-07-08 real emit
//     (Task 25): for EVERY date in the horizon, the REAL src/race.ts pairForKey
//     must return EXACTLY:
//       - pre-cutover  (dayIndex < cutover): the override if the date has one,
//         else legacy[dayIndex mod 120] — byte-identical to the OLD mod-120
//         scheme (the history-preservation rule, spec §2.4);
//       - post-cutover (cutover ≤ dayIndex < horizon): the override if present
//         (overrides are PERMANENT VETOES and win everywhere, even shadowing
//         validated slots — task-24-review NOTE-1), else
//         validated[dayIndex − cutover] converted to underscore form;
//       - beyond horizon: the xmur3 fallback (property-tested below).
//     The expected value is computed INDEPENDENTLY here from legacy-pairs.json
//     + overrides.json + data/validated.json + the recorded cutover — never
//     from the emitter's buildCalendar — so a wrong emitted calendar OR a
//     wrong pairForKey is caught. Byte-identical (JSON) comparison, zero
//     tolerated diffs.
//
//  2. The emitter's own unit fixtures: cutover splicing, space→underscore
//     conversion, the horizon freshness assert, determinism, and committed-file
//     integrity in the exact shipped byte format.
//
// Follows the house pattern (fixtures.test.ts): a check() harness, import the
// REAL exports, zero network. src/race.ts is DOM-typed, so it is imported at
// RUNTIME via a non-literal specifier — `tsc -p scripts` (no DOM lib) then does
// not pull it into the program, while tsx resolves it fine.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildCalendar,
  serializeCalendar,
  serializeMeta,
  toUnderscore,
  MIN_HORIZON_DAYS,
  EMIT_EPOCH_UTC,
  type Pair,
  type ValidatedPair,
} from './emit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, 'data');
const SRC_RACE = join(HERE, '..', '..', 'src', 'race');

// Runtime-only import of the DOM-typed src module (see header). `tsc -p scripts`
// treats a non-literal specifier as `any` and does not type-check its target.
const RACE_MODULE = '../../src/race.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${name}${detail ? ' — ' + detail : ''}`);
  }
}

// --- committed data ----------------------------------------------------------
const legacy = JSON.parse(readFileSync(join(DATA, 'legacy-pairs.json'), 'utf8')) as Pair[];
const overrides = JSON.parse(readFileSync(join(SRC_RACE, 'overrides.json'), 'utf8')) as Record<string, Pair>;
const pairsFileBytes = readFileSync(join(SRC_RACE, 'pairs.json'), 'utf8');
const emittedCalendar = JSON.parse(pairsFileBytes) as Pair[];
const committedMeta = JSON.parse(readFileSync(join(SRC_RACE, 'pairs.meta.json'), 'utf8')) as {
  cutover: number;
  horizon: number;
};
const validated = (
  JSON.parse(readFileSync(join(DATA, 'validated.json'), 'utf8')) as { entries: ValidatedPair[] }
).entries;
/** The recorded splice point. The sweep verifies both sides of it against
 *  independent sources (legacy-pairs.json / validated.json), so a wrong
 *  recorded cutover surfaces as sweep diffs. */
const CUTOVER = committedMeta.cutover;
const HORIZON_EMITTED = committedMeta.horizon;

// --- independent oracle: a hand copy of the OLD selection scheme --------------
function oldDayIndex(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return Math.floor((Date.UTC(y, m - 1, d) - EMIT_EPOCH_UTC) / 86_400_000);
}
/** Exactly the pre-Phase-3 pairForKey: override, else legacy[dayIndex mod 120]. */
function oldPairForKey(key: string): Pair {
  const o = overrides[key];
  if (o) return o;
  const i = ((oldDayIndex(key) % legacy.length) + legacy.length) % legacy.length;
  return legacy[i];
}
/** The CUTOVER-AWARE expected value (Task 25): pre-cutover dates keep the OLD
 *  scheme byte-identically; at/after the cutover the validated list rules,
 *  with overrides still winning as permanent vetoes. Built from raw committed
 *  inputs — never from the emitter. */
function expectedPairForKey(key: string): Pair {
  const i = oldDayIndex(key);
  if (i < CUTOVER) return oldPairForKey(key);
  const o = overrides[key];
  if (o) return o;
  const v = validated[i - CUTOVER];
  return { start: toUnderscore(v.start), target: toUnderscore(v.target) };
}
/** The YYYY-MM-DD key at a given dayIndex (UTC round-trip with oldDayIndex). */
function keyForIndex(i: number): string {
  const dt = new Date(EMIT_EPOCH_UTC + i * 86_400_000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// --- independent copy of the beyond-horizon xmur3 fallback --------------------
function xmur3Hash(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  h ^= h >>> 16;
  return h >>> 0;
}
function fallbackSlot(key: string, len: number): number {
  return ((xmur3Hash(key) % len) + len) % len;
}

const eq = (a: Pair, b: Pair): boolean => a.start === b.start && a.target === b.target;

// =========================== emitter unit fixtures ===========================

function emitterTests(): void {
  // `now` built from LOCAL components so emitDayIndex is timezone-independent:
  // new Date(2026,0,6) → day 5 regardless of the runner's timezone.
  const now = new Date(2026, 0, 6); // dayIndex 5

  const L: Pair[] = [
    { start: 'A_one', target: 'B_one' },
    { start: 'A_two', target: 'B_two' },
    { start: 'A_three', target: 'B_three' },
  ];
  const V: ValidatedPair[] = [
    { start: 'Whoopee cushion', target: 'Snow globe', distance: '4+', tier: 'quirky' },
    { start: 'Continental drift', target: 'Pool noodle', distance: '4+', tier: 'quirky' },
  ];
  const { calendar, meta } = buildCalendar({
    legacy: L,
    validated: V,
    cutover: 5,
    horizon: 10,
    now,
    minHorizonDays: 3, // day5 + 3 <= horizon-1(9): satisfiable, assert still active
  });

  check('emit: length === horizon', calendar.length === 10, `${calendar.length}`);
  check(
    'emit: legacy prefix materialized (slots 0..4 = legacy[i mod 3])',
    [0, 1, 2, 3, 4].every((i) => eq(calendar[i], L[i % 3])),
  );
  check(
    'emit: validated spliced at cutover with space→underscore conversion',
    eq(calendar[5], { start: 'Whoopee_cushion', target: 'Snow_globe' }) &&
      eq(calendar[6], { start: 'Continental_drift', target: 'Pool_noodle' }),
  );
  check(
    'emit: legacy tail after the validated run (slots 7..9 = legacy[i mod 3])',
    [7, 8, 9].every((i) => eq(calendar[i], L[i % 3])),
  );
  check(
    'emit: toUnderscore handles spaces but leaves other chars',
    toUnderscore('Whoopee cushion') === 'Whoopee_cushion' &&
      toUnderscore('Pinwheel (toy)') === 'Pinwheel_(toy)' &&
      toUnderscore('DNA') === 'DNA',
  );
  check(
    'emit: meta records per-slot origin + validated provenance',
    meta.slots[4].origin === 'legacy' &&
      meta.slots[4].ref === 4 % 3 &&
      meta.slots[5].origin === 'validated' &&
      meta.slots[5].distance === '4+' &&
      meta.slots[5].tier === 'quirky',
  );
  check(
    'emit: meta counts reconcile',
    meta.counts.validatedSlots === 2 && meta.counts.legacySlots === 8,
    JSON.stringify(meta.counts),
  );

  // horizon freshness assert: a calendar not >= MIN_HORIZON_DAYS ahead throws.
  let threw = false;
  try {
    buildCalendar({ legacy: L, validated: [], cutover: 0, horizon: 10, now: new Date(), minHorizonDays: MIN_HORIZON_DAYS });
  } catch {
    threw = true;
  }
  check('emit: horizon assert fires when calendar is not far enough ahead', threw);

  // an adequate horizon does NOT throw.
  let ok = true;
  try {
    buildCalendar({ legacy: L, validated: [], cutover: 3, horizon: 10, now, minHorizonDays: 3 });
  } catch {
    ok = false;
  }
  check('emit: adequate horizon does not throw', ok);

  // cutover overflow guard.
  let overflowThrew = false;
  try {
    buildCalendar({ legacy: L, validated: V, cutover: 9, horizon: 10, now, minHorizonDays: 3 });
  } catch {
    overflowThrew = true;
  }
  check('emit: validated overflowing the horizon throws', overflowThrew);

  // determinism: same inputs + same `now` → byte-identical output files.
  const r1 = buildCalendar({ legacy: L, validated: V, cutover: 5, horizon: 10, now, minHorizonDays: 3 });
  const r2 = buildCalendar({ legacy: L, validated: V, cutover: 5, horizon: 10, now: new Date(2026, 0, 6), minHorizonDays: 3 });
  check('emit: deterministic calendar bytes', serializeCalendar(r1.calendar) === serializeCalendar(r2.calendar));
  check('emit: deterministic meta bytes', serializeMeta(r1.meta) === serializeMeta(r2.meta));
}

// =========================== committed-file integrity ========================

function committedTests(): void {
  check(
    'committed: pairs.json length === meta horizon (cutover + validated count)',
    emittedCalendar.length === HORIZON_EMITTED && HORIZON_EMITTED === CUTOVER + validated.length,
    `${emittedCalendar.length} vs ${HORIZON_EMITTED} (cutover ${CUTOVER} + ${validated.length})`,
  );
  check(
    'committed: first 120 slots are the legacy rotation exactly',
    legacy.every((p, i) => eq(emittedCalendar[i], p)),
  );
  let prefixLegacy = true;
  for (let i = 0; i < CUTOVER; i++) {
    if (!eq(emittedCalendar[i], legacy[i % legacy.length])) prefixLegacy = false;
  }
  check('committed: every PRE-CUTOVER slot i === legacy[i mod 120] (history preserved)', prefixLegacy);
  let spliceExact = true;
  for (let i = CUTOVER; i < emittedCalendar.length; i++) {
    const v = validated[i - CUTOVER];
    if (!eq(emittedCalendar[i], { start: toUnderscore(v.start), target: toUnderscore(v.target) })) {
      spliceExact = false;
    }
  }
  check('committed: every POST-CUTOVER slot i === validated[i − cutover] (underscore form)', spliceExact);
  check(
    'committed: pairs.json bytes === serializeCalendar (shipped format fidelity)',
    serializeCalendar(emittedCalendar) === pairsFileBytes,
  );
}

// =========================== THE SWEEP (load-bearing) ========================

function sweepTests(pairForKey: (k: string) => Pair): void {
  // key/index round-trip must be exact or the sweep would test the wrong dates.
  check(
    'sweep: keyForIndex round-trips oldDayIndex',
    [0, 1, 120, 186, 187, 365, 554].every((i) => oldDayIndex(keyForIndex(i)) === i),
  );
  // the cutover must be sane before the sweep leans on it
  check(
    'sweep: cutover within (0, horizon] and legacy prefix nonempty',
    CUTOVER > 0 && CUTOVER <= HORIZON_EMITTED,
    `cutover ${CUTOVER}, horizon ${HORIZON_EMITTED}`,
  );

  let diffs = 0;
  let preDiffs = 0;
  const firstDiffs: string[] = [];
  for (let i = 0; i < HORIZON_EMITTED; i++) {
    const key = keyForIndex(i);
    const got = pairForKey(key);
    const want = expectedPairForKey(key);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      diffs++;
      if (i < CUTOVER) preDiffs++;
      if (firstDiffs.length < 5) {
        firstDiffs.push(`day ${i} ${key}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
  }
  check(
    `SWEEP: all ${HORIZON_EMITTED} in-horizon dates match the cutover-aware oracle (ZERO diffs)`,
    diffs === 0,
    diffs ? `${diffs} diffs (${preDiffs} pre-cutover); first: ${firstDiffs.join(' | ')}` : '',
  );
  // the history-preservation rule called out separately so a pre-cutover break
  // (the corruption class spec §2.4 exists to prevent) is named loudly.
  check('SWEEP: zero pre-cutover diffs — elapsed dates byte-identical to the old scheme', preDiffs === 0);
}

// =========================== overrides win ===================================

function overrideTests(pairForKey: (k: string) => Pair): void {
  const dates = Object.keys(overrides);
  check(
    'overrides: every override date returns its override pair (wins over calendar)',
    dates.every((d) => JSON.stringify(pairForKey(d)) === JSON.stringify(overrides[d])),
  );
  // The guard must actually do work: at least one override differs from the raw
  // calendar slot for that date (else the test proves nothing).
  const meaningful = dates.some((d) => {
    const i = oldDayIndex(d);
    return i >= 0 && i < emittedCalendar.length && !eq(overrides[d], emittedCalendar[i]);
  });
  check('overrides: at least one override differs from its raw calendar slot', meaningful);
}

// =========================== beyond-horizon fallback =========================

function fallbackTests(pairForKey: (k: string) => Pair): void {
  const len = emittedCalendar.length; // === HORIZON
  const N = 200;
  let deterministic = true;
  let allValid = true;
  let srcMatchesPorted = true;
  const slots: number[] = [];

  for (let k = 0; k < N; k++) {
    const i = emittedCalendar.length + k; // strictly beyond the horizon → fallback fires
    const key = keyForIndex(i);
    const a = pairForKey(key);
    const b = pairForKey(key);
    if (JSON.stringify(a) !== JSON.stringify(b)) deterministic = false;
    if (!emittedCalendar.some((p) => eq(p, a))) allValid = false;
    const slot = fallbackSlot(key, len);
    if (!eq(emittedCalendar[slot], a)) srcMatchesPorted = false; // src xmur3 ≡ ported xmur3
    slots.push(slot);
  }

  let adjacent = 0;
  for (let k = 1; k < slots.length; k++) if (Math.abs(slots[k] - slots[k - 1]) <= 1) adjacent++;

  check('fallback: deterministic (same key → same pair)', deterministic);
  check('fallback: always returns a valid calendar entry', allValid);
  check("fallback: src xmur3 fallback === the ported formula (calendars agree)", srcMatchesPorted);
  check(
    'fallback: adjacent dates do NOT cluster to adjacent slots',
    adjacent <= Math.ceil(N * 0.05),
    `${adjacent}/${N - 1} adjacent-slot pairs`,
  );

  // negative dayIndex (dates before the 2026-01-01 epoch) also routes to the
  // fallback and must stay valid + deterministic — never a crash.
  const preKey = keyForIndex(-30);
  const pa = pairForKey(preKey);
  check(
    'fallback: pre-epoch date is deterministic + valid',
    JSON.stringify(pa) === JSON.stringify(pairForKey(preKey)) && emittedCalendar.some((p) => eq(p, pa)),
  );
}

// =========================== run =============================================

async function main(): Promise<void> {
  emitterTests();
  committedTests();
  const race = (await import(RACE_MODULE)) as { pairForKey(k: string): Pair };
  sweepTests(race.pairForKey);
  overrideTests(race.pairForKey);
  fallbackTests(race.pairForKey);
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
