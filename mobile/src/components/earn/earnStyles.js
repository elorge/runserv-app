// mobile/src/components/earn/earnStyles.js
// Layout shared by the Driver and Courier step panels (and so by the customer-style "Boarding Pass" family).
import { StyleSheet } from 'react-native';

export const H_PAD = 20;

export const es = StyleSheet.create({
  panel: { paddingHorizontal: H_PAD, paddingTop: 16 },
  card: { borderWidth: 1, borderRadius: 18, paddingHorizontal: 16, paddingTop: 14, paddingBottom: 14, marginBottom: 12 },
  cardHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  label: { fontSize: 10, fontWeight: '800', letterSpacing: 2.5 },
  value: { fontSize: 20, fontWeight: '800' },
  valueSub: { fontSize: 13, fontWeight: '500' },
  ends: { flexDirection: 'row', justifyContent: 'space-between' },
  endTxt: { fontSize: 11, fontWeight: '500' },

  chipRow: { flexDirection: 'row', gap: 8, marginBottom: 12 },
  chip: { flex: 1, borderWidth: 1.5, borderRadius: 14, paddingVertical: 10, paddingHorizontal: 10 },
  chipTitle: { fontSize: 13, fontWeight: '700' },
  chipSub: { fontSize: 11, marginTop: 2, fontWeight: '500' },

  option: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1.5, borderRadius: 16, padding: 10, marginBottom: 10 },
  optIcon: { width: 54, height: 54, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  optImg: { width: 44, height: 44 },
  optNameRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  optName: { fontSize: 16, fontWeight: '800' },
  optSub: { fontSize: 12, marginTop: 2 },
  optPrice: { fontSize: 17, fontWeight: '800' },
  tag: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6 },
  tagTxt: { fontSize: 9, fontWeight: '800', letterSpacing: 0.8 },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  gridCell: { width: '48%', borderWidth: 1.5, borderRadius: 16, padding: 12 },

  bigNumRow: { flexDirection: 'row', alignItems: 'baseline', flexWrap: 'wrap', marginTop: 6 },
  bigNum: { fontSize: 28, fontWeight: '800', letterSpacing: -0.6 },
  bigDash: { fontSize: 22, fontWeight: '700', marginHorizontal: 6 },
  fine: { fontSize: 12, lineHeight: 17, marginTop: 6 },
  fineC: { fontSize: 12, textAlign: 'center', marginTop: 4, lineHeight: 17 },

  tileRow: { flexDirection: 'row', gap: 10, marginTop: 10 },
  tile: { flex: 1, borderWidth: 1, borderRadius: 14, padding: 12 },
  tileBig: { fontSize: 20, fontWeight: '800', marginTop: 4 },
  pips: { flexDirection: 'row', gap: 3, marginTop: 10 },
  pip: { flex: 1, height: 10, borderRadius: 3 },

  link: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10, alignSelf: 'flex-start' },
  linkTxt: { fontSize: 13, fontWeight: '700' },
  how: { borderWidth: 1, borderRadius: 14, padding: 12, marginTop: 8 },
  howRow: { fontSize: 12.5, lineHeight: 18, marginBottom: 4 },

  cta: { marginTop: 18, height: 54, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.35, shadowRadius: 18, elevation: 10 },
  ctaTxt: { fontSize: 16, fontWeight: '800', letterSpacing: 0.3 },
  ghost: { alignItems: 'center', paddingVertical: 14 },
  ghostTxt: { fontSize: 14 },
});
