// mobile/src/components/earn/CourierSteps.js
//
// The two interactive steps of the Courier "Parcel Run":
//   0 PARCEL – pick a parcel type, drag the delivery distance, see exactly what ONE run pays (rate card, after commission)
//   1 SHIFT  – how long you work and what you ask; the shift is drawn as a tape of runs and waits, so you can SEE how many
//              runs fit on a busy day and on a quiet one
// The Courier Pass (step 2) is rendered by the screen.
import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { PARCEL_TYPES, ASSUMPTIONS, MAX_MULTIPLIER, MIN_MULTIPLIER, MULTIPLIER_STEP } from '../../utils/earningsEstimate';
import { MIN_RUN_KM, MAX_RUN_KM } from './EarnMap';
import { DragSlider, CountUp, Cta, Disclosure } from './EarnKit';
import { ShiftTape } from './EarnViz';
import { es } from './earnStyles';

const PARCEL_ICON = { DOCUMENT: 'document-text-outline', SMALL: 'bag-handle-outline', MEDIUM: 'cube-outline', LARGE: 'archive-outline' };

export default function CourierSteps({ ctx }) {
  const { step, theme, e, money, accent, ink, courier, setCourier, calc, go, parcelName, parcelSub } = ctx;
  const a = ASSUMPTIONS.courier;

  // ───────────── 0 · PARCEL ─────────────
  if (step === 0) {
    const run = calc.run;
    const presets = [
      { km: 3, title: e('runNearby') },
      { km: 8, title: e('runAcross') },
      { km: 18, title: e('runLong') },
    ];
    return (
      <View style={es.panel}>
        <View style={es.grid}>
          {PARCEL_TYPES.map((p) => {
            const on = courier.parcel === p.id;
            return (
              <TouchableOpacity
                key={p.id} activeOpacity={0.88} onPress={() => setCourier({ parcel: p.id })}
                accessibilityRole="radio" accessibilityState={{ selected: on }} accessibilityLabel={`${parcelName(p.id)}, ${parcelSub(p.id)}`}
                style={[es.gridCell, { borderColor: on ? accent : theme.border, backgroundColor: on ? accent + '14' : theme.backgroundAlt }]}
              >
                <View style={[es.optIcon, { backgroundColor: on ? accent + '22' : theme.pill, width: 44, height: 44, borderRadius: 12 }]}>
                  <Ionicons name={PARCEL_ICON[p.id]} size={24} color={on ? accent : theme.muted} />
                </View>
                <Text style={[es.optName, { color: theme.foreground, marginTop: 8, fontSize: 15 }]} numberOfLines={1}>{parcelName(p.id)}</Text>
                <Text style={[es.optSub, { color: theme.hint }]} numberOfLines={2}>{parcelSub(p.id)}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={es.chipRow}>
          {presets.map((p) => {
            const on = courier.km === p.km;
            return (
              <TouchableOpacity key={p.km} activeOpacity={0.85} onPress={() => setCourier({ km: p.km })}
                accessibilityRole="button" accessibilityState={{ selected: on }}
                style={[es.chip, { borderColor: on ? accent : theme.border, backgroundColor: on ? accent + '1F' : theme.backgroundAlt }]}>
                <Text style={[es.chipTitle, { color: on ? accent : theme.foreground }]} numberOfLines={1}>{p.title}</Text>
                <Text style={[es.chipSub, { color: theme.hint }]}>~{p.km} km</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={[es.card, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
          <View style={es.cardHead}>
            <Text style={[es.label, { color: theme.hint }]}>{e('deliveryDistance')}</Text>
            <Text style={[es.value, { color: theme.foreground }]}>{courier.km} km <Text style={[es.valueSub, { color: theme.hint }]}>· ~{run.minutes} min</Text></Text>
          </View>
          <DragSlider value={courier.km} min={MIN_RUN_KM} max={MAX_RUN_KM} step={1} onChange={(km) => setCourier({ km })}
            color={accent} trackColor={theme.border} label={e('deliveryDistance')} format={(v) => `${v} km`} />
          <View style={es.ends}><Text style={[es.endTxt, { color: theme.hint }]}>{MIN_RUN_KM} km</Text><Text style={[es.endTxt, { color: theme.hint }]}>{MAX_RUN_KM} km</Text></View>
        </View>

        <View style={[es.card, { backgroundColor: theme.backgroundAlt, borderColor: accent + '66' }]}>
          <Text style={[es.label, { color: theme.hint }]}>{e('aRunPays')}</Text>
          <View style={es.bigNumRow}>
            <CountUp value={run.earnings} format={(n) => money(Math.round(n))} style={[es.bigNum, { color: accent }]} />
            <Text style={[es.valueSub, { color: theme.hint, marginLeft: 8 }]}>{e('youKeep')}</Text>
          </View>
          <Text style={[es.fine, { color: theme.muted }]}>
            {e('runBreakdown', { fee: money(run.fee), cut: money(run.fee - run.earnings), pct: Math.round(run.commissionRate * 100) })}
          </Text>
          <Text style={[es.fine, { color: theme.hint, marginTop: 2 }]}>{ctx.market.live ? e('runFineLive') : e('runFineOffline')}</Text>
        </View>
        <Cta onPress={() => go(1)} label={e('ctaPlanShift')} icon="time-outline" color={accent} ink={ink} />
      </View>
    );
  }

  // ───────────── 1 · SHIFT ─────────────
  const pct = Math.round((courier.multiplier - 1) * 100);
  const t = calc.tape;
  return (
    <View style={es.panel}>
      <View style={[es.card, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
        <View style={es.cardHead}>
          <Text style={[es.label, { color: theme.hint }]}>{e('shiftLength')}</Text>
          <Text style={[es.value, { color: theme.foreground }]}>{courier.shiftHours} h</Text>
        </View>
        <DragSlider value={courier.shiftHours} min={2} max={12} step={1} onChange={(h) => setCourier({ shiftHours: h })}
          color={accent} trackColor={theme.border} label={e('shiftLength')} format={(v) => `${v} h`} />
        <View style={es.ends}><Text style={[es.endTxt, { color: theme.hint }]}>2 h</Text><Text style={[es.endTxt, { color: theme.hint }]}>12 h</Text></View>

        <ShiftTape shiftMin={t.shiftMin} runMin={t.runMin} gapMin={t.gapBusy} color={accent} theme={theme}
          title={e('busyDay')} count={calc.runs.high} countLabel={e('runsWord')} />
        <ShiftTape shiftMin={t.shiftMin} runMin={t.runMin} gapMin={t.gapQuiet} color={accent} theme={theme}
          title={e('quietDay')} count={calc.runs.low} countLabel={e('runsWord')} />
        <Text style={[es.fine, { color: theme.hint }]}>{e('tapeLegend')}</Text>
      </View>

      <View style={[es.card, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
        <View style={es.cardHead}>
          <Text style={[es.label, { color: theme.hint }]}>{e('yourAsk')}</Text>
          <Text style={[es.value, { color: theme.foreground }]}>
            {courier.multiplier.toFixed(2)}× <Text style={[es.valueSub, { color: theme.hint }]}>{pct > 0 ? `· +${pct}%` : `· ${e('standardFee')}`}</Text>
          </Text>
        </View>
        <DragSlider value={courier.multiplier} min={MIN_MULTIPLIER} max={MAX_MULTIPLIER} step={MULTIPLIER_STEP}
          onChange={(m) => setCourier({ multiplier: m })} color={accent} trackColor={theme.border}
          ticks={[1, 1.1, 1.2, 1.3]} label={e('yourAsk')} format={(v) => `${v.toFixed(2)}×`} />
        <Text style={[es.fine, { color: theme.hint }]}>{e('askExplainCourier')}</Text>
      </View>

      <View style={[es.card, { backgroundColor: theme.backgroundAlt, borderColor: accent + '66' }]}>
        <Text style={[es.label, { color: theme.hint }]}>{e('estShift')}</Text>
        <View style={es.bigNumRow}>
          <CountUp value={calc.perShift.low} format={(n) => money(Math.round(n))} style={[es.bigNum, { color: theme.foreground }]} />
          <Text style={[es.bigDash, { color: theme.hint }]}>–</Text>
          <CountUp value={calc.perShift.high} format={(n) => money(Math.round(n))} style={[es.bigNum, { color: accent }]} />
        </View>
        <Text style={[es.fine, { color: theme.muted }]}>{e('shiftLine', { lo: calc.runs.low, hi: calc.runs.high, keep: money(calc.run.earnings) })}</Text>
        <Disclosure title={e('howTitle')} theme={theme} color={accent} lines={[
          e('howRunTime', { handoff: a.handoffMinutes }),
          e('howWaits', { quiet: a.gapQuietMinutes, busy: a.gapBusyMinutes }),
          e('howAsk', { loss: Math.round(a.requestLossAtMax * 100) }),
          e('howCommission', { pct: Math.round(calc.run.commissionRate * 100) }),
          e('howNotIncluded'),
        ]} />
      </View>
      <Cta onPress={() => go(2)} label={e('ctaGetCourierPass')} icon="ticket-outline" color={accent} ink={ink} />
    </View>
  );
}
