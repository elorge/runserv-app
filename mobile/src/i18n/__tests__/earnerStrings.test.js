import fs from 'fs';
import path from 'path';
import { EARN_STR } from '../earnerStrings';
import en from '../locales/en.json';

const root = path.join(__dirname, '..', '..');
const files = [
  'screens/Auth/EarnerPreviewScreen.js', 'screens/Shared/RoadToOnlineScreen.js',
  'components/earn/DriverSteps.js', 'components/earn/CourierSteps.js', 'components/earn/EarnerPass.js', 'components/earn/RoadToOnline.js', 'components/earn/RoadCardHost.js', 'components/earn/EarningsBreakdown.js',
];
const used = new Set();
for (const f of files) {
  const src = fs.readFileSync(path.join(root, f), 'utf8');
  for (const m of src.matchAll(/\be\(\s*'([A-Za-z0-9]+)'/g)) used.add(m[1]);
}
// keys built dynamically in the screens
for (const p of ['d0', 'd1', 'd2', 'd3', 'c0', 'c1', 'c2']) ['Eyebrow', 'Title', 'Sub'].forEach((k) => used.add(p + k));
['subTricycle', 'subMoto', 'subCar', 'subVan', 'pDocument', 'pSmall', 'pMedium', 'pLarge', 'pDocumentSub', 'pSmallSub', 'pMediumSub', 'pLargeSub',
  'roadHeadBlocked', 'roadHeadAction', 'roadHeadWaiting', 'roadHeadDone', 'roadSubBlocked', 'roadSubAction', 'roadSubWaiting', 'roadSubDone'].forEach((k) => used.add(k));

describe('earner strings', () => {
  it('every key the screens use exists', () => {
    const missing = [...used].filter((k) => !(k in EARN_STR));
    expect(missing).toEqual([]);
  });
  it('the English locale carries exactly the same strings (for translators)', () => {
    expect(en.earner).toEqual(EARN_STR);
  });
  it('days lists have seven entries', () => {
    expect(EARN_STR.dayLetters.split(',')).toHaveLength(7);
    expect(EARN_STR.dayNames.split(',')).toHaveLength(7);
  });
  it('no income promises: no "earn ₦…" or per-month claims', () => {
    for (const v of Object.values(EARN_STR)) expect(v).not.toMatch(/per month|a month|guarantee/i);
  });
});
