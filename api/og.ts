// GET /api/og?lang=en&t=Harry_Kane&t=Photosynthesis[&race=YYYY-MM-DD&cards=N]
// A 1200x630 index-card-styled share image, rendered with @vercel/og (satori).
// Unauthenticated by design, GET-only, a pure function of its query -> cacheable
// hard. Titles arrive already URL-decoded via repeated `t` params.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ImageResponse } from '@vercel/og';
import { HttpError, handle } from './_lib/http.js';
import {
  buildTrail,
  cardCount,
  cardsLabel,
  parseRaceParams,
  trailDisplay,
  type RaceMeta,
  type Trail,
} from './_lib/share.js';

// --- design system values (src/ds/tokens/colors.css) ---
const DESK = '#eef0f3';
const CARD = '#ffffff';
const CARROT = '#d9772e';
const CARROT_DEEP = '#a75718';
const CARROT_TINT = '#f8e4cc';
const INK1 = '#21242b';
const INK3 = '#99a0ac';
const LINE = '#e3e6eb';

// Fonts must be TTF/OTF/WOFF (satori rejects woff2). Literata TTFs live beside
// this function in api/_assets so Vercel's file tracer bundles them with the
// deployed lambda (literal readFileSync paths get traced reliably).
const FONT_REGULAR = readFileSync(
  fileURLToPath(new URL('./_assets/Literata-Regular.ttf', import.meta.url)),
);
const FONT_SEMIBOLD = readFileSync(
  fileURLToPath(new URL('./_assets/Literata-SemiBold.ttf', import.meta.url)),
);

// A satori element tree is plain objects — no React/JSX needed (keeps this a
// .ts file the api tsconfig compiles).
type Style = Record<string, string | number>;
interface El {
  type: string;
  props: { style?: Style; children?: unknown };
}
function el(type: string, style: Style, children?: unknown): El {
  return { type, props: { style, children } };
}

function trailFontSize(len: number): number {
  if (len > 90) return 40;
  if (len > 60) return 50;
  if (len > 34) return 64;
  return 82;
}

function cardImage(trail: Trail, race: RaceMeta | null): El {
  const trailStr = trailDisplay(trail.titles);
  const n = cardCount(trail, race);

  const wordmark = el('div', { display: 'flex', alignItems: 'center' }, [
    el('div', {
      width: '18px',
      height: '18px',
      borderRadius: '9px',
      background: CARROT,
      marginRight: '14px',
    }),
    el('div', { fontSize: '30px', fontWeight: 600, color: INK1, letterSpacing: '0.3px' }, 'Wabbit Hole'),
  ]);

  const header = el(
    'div',
    { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    race
      ? [
          wordmark,
          el(
            'div',
            {
              display: 'flex',
              background: CARROT,
              color: '#ffffff',
              fontSize: '22px',
              fontWeight: 600,
              padding: '8px 20px',
              borderRadius: '999px',
            },
            `Daily race · ${race.date}`,
          ),
        ]
      : [wordmark],
  );

  const trailBlock = el('div', { display: 'flex' }, [
    el(
      'div',
      {
        fontWeight: 600,
        color: INK1,
        fontSize: `${trailFontSize(trailStr.length)}px`,
        lineHeight: 1.15,
      },
      trailStr,
    ),
  ]);

  const footer = el(
    'div',
    { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    [
      el(
        'div',
        {
          display: 'flex',
          background: CARROT_TINT,
          color: CARROT_DEEP,
          fontSize: '26px',
          fontWeight: 600,
          padding: '10px 24px',
          borderRadius: '999px',
        },
        cardsLabel(n),
      ),
      el('div', { display: 'flex', fontSize: '24px', color: INK3 }, 'wabbithole.io'),
    ],
  );

  const inner = el(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      flex: '1',
      padding: '52px 60px',
      justifyContent: 'space-between',
    },
    [header, trailBlock, footer],
  );

  const card = el(
    'div',
    {
      display: 'flex',
      flexDirection: 'column',
      flex: '1',
      background: CARD,
      borderRadius: '22px',
      border: `1px solid ${LINE}`,
      overflow: 'hidden',
      boxShadow: '0 12px 34px rgba(30,33,40,0.13)',
    },
    [el('div', { display: 'flex', height: '14px', background: CARROT }), inner],
  );

  return el(
    'div',
    {
      width: '1200px',
      height: '630px',
      display: 'flex',
      padding: '46px',
      background: DESK,
      fontFamily: 'Literata',
    },
    [card],
  );
}

export default handle(async (request) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    throw new HttpError(405, 'method_not_allowed');
  }

  const url = new URL(request.url);
  const trail = buildTrail(url.searchParams.get('lang'), url.searchParams.getAll('t'));
  if (!trail) throw new HttpError(400, 'bad_request');

  const race = parseRaceParams(url.searchParams.get('race'), url.searchParams.get('cards'));
  if (!race.ok) throw new HttpError(400, 'bad_request');

  // @vercel/og types the element as a React node; a plain satori tree is
  // equivalent at runtime, so cast the constructor to accept it.
  const Img = ImageResponse as unknown as new (
    element: unknown,
    options: unknown,
  ) => Response;

  return new Img(cardImage(trail, race.race), {
    width: 1200,
    height: 630,
    fonts: [
      { name: 'Literata', data: FONT_REGULAR, weight: 400, style: 'normal' },
      { name: 'Literata', data: FONT_SEMIBOLD, weight: 600, style: 'normal' },
    ],
    headers: {
      'cache-control': 'public, max-age=86400, s-maxage=86400, immutable',
    },
  });
});
