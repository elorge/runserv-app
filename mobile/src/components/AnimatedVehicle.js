// mobile/src/components/AnimatedVehicle.js
// A vehicle icon drawn above the map that glides between REAL driver GPS fixes and turns with the road.
// All the movement rules (glide, short-way turn, jitter, stale) live in utils/vehicleMotion.js.
// It never shows a made-up car: it draws nothing until the first real fix, and after 90 s of silence it dims and says
// "last seen ..." instead of looking live.
import React, { useEffect, useRef, useState } from 'react';
import { View, Image, Text, StyleSheet } from 'react-native';
import { ML } from './maplibreModule';
import { VehicleMotion, ageLabel } from '../utils/vehicleMotion';
import { vehicleIconSource, vehicleIconSize } from '../utils/vehicleIcons';

const FRAME_MS = 66;        // ~15 fps while moving: plenty for a slow vehicle on a phone map
const IDLE_MS  = 1000;      // when settled, only wake once a second (to notice staleness)

export default function AnimatedVehicle({ id, fix, vehicleKey, color = '#0092F5', selected = false, label, staleLabel, onPress }) {
  const motion = useRef(new VehicleMotion()).current;
  const annRef = useRef(null);
  const [frame, setFrame] = useState(() => { motion.push(fix || {}); return motion.sample(); });

  // New real fix -> tell the motion engine.
  useEffect(() => { if (fix) motion.push(fix); }, [fix, motion]);

  // Animation loop: fast while gliding/turning, slow when settled. Stops on unmount.
  useEffect(() => {
    let timer; let live = true;
    const tick = () => {
      if (!live) return;
      const now = Date.now();
      setFrame(motion.sample(now));
      timer = setTimeout(tick, motion.isAnimating(now) ? FRAME_MS : IDLE_MS);
    };
    tick();
    return () => { live = false; clearTimeout(timer); };
  }, [motion]);

  useEffect(() => { try { annRef.current?.refresh?.(); } catch { /* older native build: harmless */ } }, [Math.round(frame.rotation), frame.stale]);

  if (!ML || frame.lat == null) return null;          // nothing real to draw yet
  const size = vehicleKey ? vehicleIconSize(vehicleKey) : 30;
  const dim = frame.stale ? 0.5 : 1;

  return (
    <ML.ViewAnnotation ref={annRef} id={id || 'veh-assigned'} lngLat={[frame.lng, frame.lat]} anchor="center" onPress={onPress}>
      <View style={[st.box, { width: size + 20, height: size + 20, opacity: dim }]}>
        {selected ? <View style={[st.ring, { width: size + 14, height: size + 14, borderRadius: (size + 14) / 2 }]} /> : null}
        <View style={{ transform: [{ rotate: `${frame.rotation || 0}deg` }] }}>
          {vehicleKey
            ? <Image source={vehicleIconSource(vehicleKey)} style={{ width: size, height: size }} resizeMode="contain" />
            : <View style={[st.dot, { backgroundColor: color }]} />}
        </View>
        {frame.stale ? (
          <View style={st.badge}><Text style={st.badgeTxt}>{staleLabel ? staleLabel(ageLabel(frame.ageMs)) : `Last seen ${ageLabel(frame.ageMs)} ago`}</Text></View>
        ) : null}
      </View>
    </ML.ViewAnnotation>
  );
}

const st = StyleSheet.create({
  box: { alignItems: 'center', justifyContent: 'center' },
  ring: { position: 'absolute', backgroundColor: 'rgba(0,146,245,0.18)', borderWidth: 2, borderColor: '#0092F5' },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2, borderColor: '#fff' },
  badge: { position: 'absolute', top: '100%', backgroundColor: '#01152B', borderRadius: 8, paddingHorizontal: 6, paddingVertical: 2 },
  badgeTxt: { color: '#fff', fontSize: 10, fontWeight: '700' },
});
