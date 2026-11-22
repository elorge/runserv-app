// mobile/src/components/earn/DriverSteps.js
//
// The three interactive steps of the Driver "Earnings Simulator":
//   0 VEHICLE  – Keke / Okada / Car / Van, each with what a typical trip keeps (from the real rate card)
//   1 WEEK     – hours a day, days a week -> a live weekly RANGE and a week strip that fills as you plan
//   2 PRICE    – your asking-price multiplier: earn more per trip, get fewer requests
// The Driver Pass (step 3) is rendered by the screen.
import React from 'react';
import { View, Text, TouchableOpacity, Image } from 'react-native';
import { BRAND } from '../../theme/theme';
import { resolveVehicleIconKey, vehicleIconSource } from '../../utils/vehicleIcons';
import { ASSUMPTIONS, MAX_MULTIPLIER, MIN_MULTIPLIER, MULTIPLIER_STEP } from '../../utils/earningsEstimate';
import { DragSlider, CountUp, Cta, Disclosure } from './EarnKit';
import { WeekStrip } from './EarnViz';
import { es } from './earnStyles';

export default function DriverSteps({ ctx }) {
  const { step, theme, mode, e, money, accent, ink, driver, setDriver, calc, quotes, best, maxDay, vehicleName, vehicleSub, go, ask, letters, names } = ctx;
  const a = ASSUMPTIONS.driver;
  const tagColor = mode === 'dark' ? BRAND.keke : '#8A6200';

  // ───────────── 0 · VEHICLE ─────────────
  if (step === 0) {
    return (
      <View style={es.panel}>
        {quotes.map((q) => {
          const on = q.v === driver.vehicleType;
          const key = resolveVehicleIconKey(q.v, { colour: 'blue' });
          return (
            <TouchableOpacity
              key={q.v} activeOpacity={0.88} onPress={() => setDriver({ vehicleType: q.v })}
              accessibilityRole="radio" accessibilityState={{ selected: on }}
              accessibilityLabel={`${vehicleName(q.v)}, ${money(q.earnings)} ${e('perTrip')}`}
              style={[es.option, { borderColor: on ? accent : theme.border, backgroundColor: on ? accent + '14' : theme.backgroundAlt }]}
            >
              <View style={[es.optIcon, { backgroundColor: on ? accent + '22' : theme.pill }]}>
                <Image source={vehicleIconSource(key)} style={es.optImg} resizeMode="contain" />
              </View>
              <View style={{ flex: 1 }}>
                <View style={es.optNameRow}>
                  <Text style={[es.optName, { color: theme.foreground }]}>{vehicleName(q.v)}</Text>
                  {q.v === best && (
                    <View style={[es.tag, { backgroundColor: BRAND.keke + '26' }]}><Text style={[es.tagTxt, { color: tagColor }]}>{e('bestPerTrip')}</Text></View>
                  )}
                </View>
                <Text style={[es.optSub, { color: theme.hint }]} numberOfLines={1}>{vehicleSub(q.v)}</Text>
              </View>
              <View style={{ alignItems: 'flex-end' }}>
                <Text style={[es.optPrice, { color: on ? accent : theme.foreground }]}>{money(q.earnings)}</Text>
                <Text style={[es.optSub, { color: theme.hint }]}>{e('perTrip')}</Text>
              </View>
            </TouchableOpacity>
          );
        })}
        <Text style={[es.fineC, { color: theme.hint }]}>{ctx.market.live ? e('vehicleFineLive', { km: a.typicalTripKm }) : e('vehicleFineOffline', { km: a.typicalTripKm })}</Text>
        <Cta onPress={() => go(1)} label={e('ctaPlanWeek')} icon="calendar-outline" color={accent} ink={ink} />
      </View>
    );
  }

  // ───────────── 1 · WEEK ─────────────
  if (step === 1) {
    const presets = [
      { h: 4, d: [0, 1, 2, 3, 4], title: e('presetPartTime') },
      { h: 8, d: [0, 1, 2, 3, 4], title: e('presetFullTime') },
      { h: 10, d: [0, 1, 2, 3, 4, 5], title: e('presetHustle') },
    ];
    return (
      <View style={es.panel}>
        <View style={es.chipRow}>
          {presets.map((p) => {
            const on = driver.hours === p.h && driver.days.length === p.d.length && p.d.every((x) => driver.days.includes(x));
            return (
              <TouchableOpacity key={p.title} activeOpacity={0.85} onPress={() => setDriver({ hours: p.h, days: p.d })}
                accessibilityRole="button" accessibilityState={{ selected: on }}
                style={[es.chip, { borderColor: on ? accent : theme.border, backgroundColor: on ? accent + '1F' : theme.backgroundAlt }]}>
                <Text style={[es.chipTitle, { color: on ? accent : theme.foreground }]} numberOfLines={1}>{p.title}</Text>
                <Text style={[es.chipSub, { color: theme.hint }]}>{e('presetSub', { h: p.h, d: p.d.length })}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        <View style={[es.card, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
          <View style={es.cardHead}>
            <Text style={[es.label, { color: theme.hint }]}>{e('hoursPerDay')}</Text>
            <Text style={[es.value, { color: theme.foreground }]}>{driver.hours} h</Text>
          </View>
          <DragSlider value={driver.hours} min={2} max={14} step={1} onChange={(h) => setDriver({ hours: h })}
            color={accent} trackColor={theme.border} label={e('hoursPerDay')} format={(v) => `${v} h`} />
          <View style={es.ends}><Text style={[es.endTxt, { color: theme.hint }]}>2 h</Text><Text style={[es.endTxt, { color: theme.hint }]}>14 h</Text></View>
        </View>

        <View style={[es.card, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
          <View style={[es.cardHead, { marginBottom: 12 }]}>
            <Text style={[es.label, { color: theme.hint }]}>{e('daysPerWeek')}</Text>
            <Text style={[es.value, { color: theme.foreground }]}>{driver.days.length}</Text>
          </View>
          <WeekStrip
            days={driver.days} onToggle={(i) => ctx.toggleDay(i)}
            low={calc.rawDay.low} high={calc.rawDay.high} max={maxDay}
            color={accent} theme={theme} letters={letters} names={names}
            workingLabel={e('dayWorking')} restLabel={e('dayRest')}
          />
          <Text style={[es.fine, { color: theme.hint }]}>{e('weekHint')}</Text>
        </View>

        <View style={[es.card, { backgroundColor: theme.backgroundAlt, borderColor: accent + '66' }]}>
          <Text style={[es.label, { color: theme.hint }]}>{e('estWeek')}</Text>
          <View style={es.bigNumRow}>
            <CountUp value={calc.perWeek.low} format={(n) => money(Math.round(n))} style={[es.bigNum, { color: theme.foreground }]} />
            <Text style={[es.bigDash, { color: theme.hint }]}>–</Text>
            <CountUp value={calc.perWeek.high} format={(n) => money(Math.round(n))} style={[es.bigNum, { color: accent }]} />
          </View>
          <Text style={[es.fine, { color: theme.muted }]}>
            {e('tripsLine', { lo: Math.max(1, Math.round(calc.tripsPerDay.low)), hi: Math.max(1, Math.round(calc.tripsPerDay.high)), keep: money(calc.trip.earnings) })}
          </Text>
          <Disclosure title={e('howTitle')} theme={theme} color={accent} lines={[
            e('howTrip', { km: a.typicalTripKm }),
            e('howDemand', { quiet: a.tripsPerHourQuiet, busy: a.tripsPerHourBusy }),
            e('howCommission', { pct: Math.round(calc.trip.commissionRate * 100) }),
            e('howNotIncluded'),
          ]} />
        </View>
        <Cta onPress={() => go(2)} label={e('ctaSetPrice')} icon="pricetag-outline" color={accent} ink={ink} />
      </View>
    );
  }

  // ───────────── 2 · PRICE ─────────────
  const pct = Math.round((driver.multiplier - 1) * 100);
  const pips = 10;
  const filled = Math.round(calc.share * pips);
  return (
    <View style={es.panel}>
      <View style={[es.card, { backgroundColor: theme.backgroundAlt, borderColor: theme.border }]}>
        <View style={es.cardHead}>
          <Text style={[es.label, { color: theme.hint }]}>{e('yourAsk')}</Text>
          <Text style={[es.value, { color: theme.foreground }]}>
            {driver.multiplier.toFixed(2)}× <Text style={[es.valueSub, { color: theme.hint }]}>{pct > 0 ? `· +${pct}%` : `· ${e('standardFare')}`}</Text>
          </Text>
        </View>
        <DragSlider
          value={driver.multiplier} min={MIN_MULTIPLIER} max={MAX_MULTIPLIER} step={MULTIPLIER_STEP}
          onChange={(m) => setDriver({ multiplier: m })} color={accent} trackColor={theme.border}
          ticks={[1, 1.1, 1.2, 1.3]} label={e('yourAsk')} format={(v) => `${v.toFixed(2)}×`}
        />
        <View style={es.ends}><Text style={[es.endTxt, { color: theme.hint }]}>1.00×</Text><Text style={[es.endTxt, { color: theme.hint }]}>{MAX_MULTIPLIER.toFixed(2)}×</Text></View>

        <View style={es.tileRow}>
          <View style={[es.tile, { borderColor: theme.border, backgroundColor: theme.pill }]}>
            <Text style={[es.label, { color: theme.hint }]}>{e('youKeepPerTrip')}</Text>
            <CountUp value={calc.trip.earnings} format={(n) => money(Math.round(n))} style={[es.tileBig, { color: accent }]} />
            <Text style={[es.fine, { color: theme.muted, marginTop: 2 }]}>{ask.extra > 0 ? e('moreThanStandard', { extra: money(ask.extra) }) : e('atStandardFare')}</Text>
          </View>
          <View style={[es.tile, { borderColor: theme.border, backgroundColor: theme.pill }]}>
            <Text style={[es.label, { color: theme.hint }]}>{e('requests')}</Text>
            <View style={es.pips} accessible accessibilityLabel={e('requestsA11y', { n: filled, total: pips })}>
              {Array.from({ length: pips }, (_, i) => <View key={i} style={[es.pip, { backgroundColor: i < filled ? accent : theme.border }]} />)}
            </View>
            <Text style={[es.fine, { color: theme.muted, marginTop: 8 }]}>{pct > 0 ? e('fewerRequests') : e('allRequests')}</Text>
          </View>
        </View>
        <Text style={[es.fine, { color: theme.hint }]}>{e('askExplain')}</Text>
      </View>

      <View style={[es.card, { backgroundColor: theme.backgroundAlt, borderColor: accent + '66' }]}>
        <Text style={[es.label, { color: theme.hint }]}>{e('estWeek')}</Text>
        <View style={es.bigNumRow}>
          <CountUp value={calc.perWeek.low} format={(n) => money(Math.round(n))} style={[es.bigNum, { color: theme.foreground }]} />
          <Text style={[es.bigDash, { color: theme.hint }]}>–</Text>
          <CountUp value={calc.perWeek.high} format={(n) => money(Math.round(n))} style={[es.bigNum, { color: accent }]} />
        </View>
        <Text style={[es.fine, { color: theme.muted }]}>{pct > 0 ? e('rangeWidens') : e('rangeStandard')}</Text>
        <Disclosure title={e('howTitle')} theme={theme} color={accent} lines={[
          e('howTrip', { km: a.typicalTripKm }),
          e('howDemand', { quiet: a.tripsPerHourQuiet, busy: a.tripsPerHourBusy }),
          e('howAsk', { loss: Math.round(a.requestLossAtMax * 100) }),
          e('howCommission', { pct: Math.round(calc.trip.commissionRate * 100) }),
          e('howNotIncluded'),
        ]} />
      </View>
      <Cta onPress={() => go(3)} label={e('ctaGetDriverPass')} icon="ticket-outline" color={accent} ink={ink} />
    </View>
  );
}
