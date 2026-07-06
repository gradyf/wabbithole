// Editorially curated, indexable trails — the one exception to the
// "/t/ pages are share-only, noindex" rule (see api/t.ts). Each entry is a
// small, honest landing page for a genuinely interesting Wikipedia trail:
// self-canonical, no redirect, real crawlable content. Keep this list short
// and hand-picked — it is a curated shelf, not a doorway-page generator.
//
// `titles` are Wikipedia's canonical underscore forms (verified against the
// REST summary endpoint). The display form is just underscores -> spaces, so
// this list also fixes the exact URLs that belong in public/sitemap.xml:
//   /t/{lang}/{titles joined by "/"}    (each segment already URL-safe ASCII)
// If you edit this list, mirror the change into public/sitemap.xml.

export interface FeaturedTrail {
  lang: string;
  titles: string[]; // canonical underscore titles, in trail order
  description: string; // one honest human sentence
}

export const FEATURED_TRAILS: FeaturedTrail[] = [
  {
    lang: 'en',
    titles: ['Ada_Lovelace', 'Analytical_engine', 'Charles_Babbage', 'Difference_engine'],
    description:
      "From the first computer programmer to the Victorian brass-and-gears machines that dreamed up computing a century early.",
  },
  {
    lang: 'en',
    titles: ['Voyager_1', 'Voyager_Golden_Record', 'Carl_Sagan', 'Pale_Blue_Dot'],
    description:
      "Follow humanity's message to the stars, from the Voyager probe to the golden record and the famous pale blue dot.",
  },
  {
    lang: 'en',
    titles: ['Vincent_van_Gogh', 'The_Starry_Night', 'Post-Impressionism', 'Georges_Seurat'],
    description:
      "Wander from Van Gogh's swirling night sky into the movement that pulled painting toward the modern age.",
  },
  {
    lang: 'en',
    titles: ['Chocolate', 'Theobroma_cacao', 'Mesoamerica', 'Maya_civilization'],
    description:
      "Trace chocolate back to the cacao tree and the ancient Mesoamerican cultures that first prized it.",
  },
  {
    lang: 'en',
    titles: ['Basketball', 'National_Basketball_Association', 'Michael_Jordan', 'Chicago_Bulls'],
    description:
      "Go from the rules of basketball to the NBA and the career that made Michael Jordan a household name.",
  },
  {
    lang: 'en',
    titles: ['Mount_Everest', 'Himalayas', 'Plate_tectonics', 'Continental_drift'],
    description:
      "Climb the world's highest peak, then fall into the plate tectonics that keep pushing it higher.",
  },
  {
    lang: 'en',
    titles: ['Roman_Empire', 'Julius_Caesar', 'Cleopatra', 'Ancient_Egypt'],
    description:
      "Cross the ancient world from the Roman Empire through Caesar and Cleopatra into the age of the pharaohs.",
  },
  {
    lang: 'en',
    titles: ['The_Beatles', 'Abbey_Road', 'Abbey_Road_Studios', 'George_Martin'],
    description:
      "Walk from the Beatles across their most famous album into the studio and the producer who shaped their sound.",
  },
  {
    lang: 'en',
    titles: ['Photosynthesis', 'Chlorophyll', 'Chloroplast', 'Cyanobacteria'],
    description:
      "See how life turns sunlight into food, from the green pigment down to the ancient microbes that started it.",
  },
  {
    lang: 'en',
    titles: ['Coffee', 'Coffea', 'Ethiopia', 'Kingdom_of_Aksum'],
    description:
      "Follow coffee from the cup back to its wild origins in the highlands of Ethiopia and an ancient African kingdom.",
  },
];

// The canonical /t/ path for a featured trail (each segment percent-encoded).
export function featuredPath(t: FeaturedTrail): string {
  const segs = t.titles.map((s) => encodeURIComponent(s));
  return `/t/${t.lang}/${segs.join('/')}`;
}

// Match a request's parsed trail (display-form titles, spaces) to a featured
// entry. Exact, case-sensitive, order-sensitive: only the one canonical URL
// per trail earns the indexable page; every other casing/encoding falls
// through to the share-only path (which is what canonicalization wants).
export function findFeatured(lang: string, displayTitles: string[]): FeaturedTrail | null {
  for (const t of FEATURED_TRAILS) {
    if (t.lang !== lang) continue;
    if (t.titles.length !== displayTitles.length) continue;
    const same = t.titles.every((title, i) => title.replace(/_/g, ' ') === displayTitles[i]);
    if (same) return t;
  }
  return null;
}
