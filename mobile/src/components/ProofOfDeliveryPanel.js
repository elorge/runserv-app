// mobile/src/components/ProofOfDeliveryPanel.js — courier hand-over proof (M16 §3.5).
// Recipient code + photo -> POST /deliveries/:id/proof; failed delivery -> POST /deliveries/:id/failed; return -> /returned.
// The panel never marks anything delivered itself: it reports the SERVER's new proof state through onProofChange.
import React, { useRef, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, ActivityIndicator, Image, Alert, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { deliveryAPI, uploadAPI } from '../services/api';
import { FAIL_REASONS, cleanCode, isRecipientCode, proofState, validateFailure, proofErrorMessage, isAmbiguousFailure, proofFromActive } from '../utils/proofOfDelivery';

const RED = '#DC2626';

export default function ProofOfDeliveryPanel({ delivery, theme, accent = '#00C2A8', onProofChange, onReturned }) {
  const state = proofState(delivery);
  const [mode, setMode] = useState('code');               // 'code' | 'failed'
  const [code, setCode] = useState('');
  const [photo, setPhoto] = useState(null);               // local asset
  const [photoRef, setPhotoRef] = useState(null);         // private reference returned by the server (kept across retries)
  const [upload, setUpload] = useState('idle');           // idle | uploading | failed | done
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [reason, setReason] = useState(null);
  const [note, setNote] = useState('');
  const pending = useRef(false);

  if (state === 'NONE' || !delivery?.id) return null;
  const merge = (patch) => onProofChange?.({ ...(delivery.proof || {}), ...patch });
  const card = [st.card, { backgroundColor: theme.backgroundAlt, borderColor: accent + '40' }];

  const takePhoto = async () => {
    setError(null);
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (perm.status !== 'granted') { setError('Camera permission is off. Allow it in Settings to take the proof photo.'); return; }
    const r = await ImagePicker.launchCameraAsync({ quality: 0.6, allowsEditing: false });
    if (r.canceled || !r.assets?.[0]) return;
    setPhoto(r.assets[0]); setPhotoRef(null); setUpload('idle');
  };

  const ensureUploaded = async () => {
    if (photoRef) return photoRef;
    setUpload('uploading');
    try { const ref = await uploadAPI.uploadPodPhoto(photo); setPhotoRef(ref); setUpload('done'); return ref; }
    catch (e) { setUpload('failed'); throw e; }
  };

  const run = async (fn) => {
    if (pending.current) return; pending.current = true; setBusy(true); setError(null);
    try { await fn(); } finally { pending.current = false; setBusy(false); }
  };

  // After a timeout / lost connection the code may already have been checked by the server. Re-read the server state; never re-send the code on the courier's behalf.
  const recheck = async () => {
    try { const proof = proofFromActive(await deliveryAPI.getActiveDelivery(), delivery.id); return proof; } catch { return null; }
  };

  const confirmHandover = () => run(async () => {
    let stage = 'upload';
    try {
      const ref = photo ? await ensureUploaded() : undefined;
      stage = 'verify';
      await deliveryAPI.verifyProof(delivery.id, { code, ...(ref ? { photoUrl: ref } : {}) });
      merge({ verified: true, locked: false }); setConfirming(false); setCode('');
    } catch (e) {
      if (stage === 'upload') { setError({ text: 'The photo did not upload, so nothing was submitted. Check your connection and try again.', retry: true }); return; }
      if (isAmbiguousFailure(e)) {
        const proof = await recheck();
        if (proof?.verified) { merge({ ...proof }); setConfirming(false); setCode(''); return; }
        if (proof?.locked) { merge({ ...proof }); setConfirming(false); setCode(''); setError(proofErrorMessage({ status: 429, code: 'POD_LOCKED' })); return; }
        setError(proofErrorMessage(e));     // the code stays in the box (memory only) so one tap retries; nothing is stored on the device
        return;
      }
      const m = proofErrorMessage(e); setError(m); setConfirming(false);
      if (e?.code === 'POD_LOCKED') merge({ locked: true });
      if (e?.code === 'POD_ALREADY_VERIFIED') merge({ verified: true, locked: false });
      setCode('');
    }
  });

  const submitFailure = () => {
    const v = validateFailure({ reason, note });
    if (!v.ok) { setError({ text: v.errors.reason || v.errors.note }); return; }
    Alert.alert('Report failed delivery?', 'The parcel goes back to the sender. This cannot be undone.', [
      { text: 'Go back', style: 'cancel' },
      { text: 'Report', style: 'destructive', onPress: () => run(async () => {
        try {
          const ref = photo ? await ensureUploaded() : undefined;
          await deliveryAPI.failDelivery(delivery.id, { reason, ...(note.trim() ? { note: note.trim() } : {}), ...(ref ? { photoUrl: ref } : {}) });
          merge({ failed: true, failedReason: reason, returnStatus: 'RETURNING' }); setMode('code');
        } catch (e) { setError(proofErrorMessage(e)); }
      }) },
    ]);
  };

  const returned = () => run(async () => {
    try { await deliveryAPI.confirmReturned(delivery.id); merge({ returnStatus: 'RETURNED' }); onReturned?.(); }
    catch (e) { setError(proofErrorMessage(e)); }
  });

  const photoRow = (
    <View style={{ marginBottom: 10 }}>
      <TouchableOpacity onPress={takePhoto} disabled={busy} accessibilityRole="button" style={[st.photoBtn, { borderColor: theme.border, backgroundColor: theme.background }]}>
        {photo ? <Image source={{ uri: photo.uri }} style={st.thumb} accessibilityLabel="Proof photo preview" /> : <Ionicons name="camera-outline" size={22} color={accent} />}
        <Text style={{ color: theme.foreground, fontWeight: '700', flex: 1 }}>{photo ? 'Retake proof photo' : 'Take proof photo'}</Text>
        {upload === 'uploading' ? <ActivityIndicator size="small" color={accent} /> : upload === 'done' ? <Ionicons name="checkmark-circle" size={20} color={accent} /> : upload === 'failed' ? <Ionicons name="refresh" size={20} color={RED} /> : null}
      </TouchableOpacity>
    </View>
  );
  const errView = error ? <Text accessibilityLiveRegion="polite" style={{ color: RED, fontSize: 13, marginBottom: 8 }}>{error.text || error}</Text> : null;

  if (state === 'VERIFIED') return <View style={card}><Text style={[st.title, { color: theme.foreground }]}><Ionicons name="checkmark-circle" size={16} color={accent} /> Hand-over confirmed</Text><Text style={{ color: theme.hint }}>You can now mark the parcel as delivered.</Text></View>;

  if (state === 'FAILED_RETURNING' || state === 'RETURNED') return (
    <View style={card}>
      <Text style={[st.title, { color: theme.foreground }]}>Delivery failed: return to sender</Text>
      <Text style={{ color: theme.hint, marginBottom: 10 }}>{state === 'RETURNED' ? 'The parcel has been returned. Thank you.' : 'Take the parcel back to the pickup address, hand it to the sender, then confirm below.'}</Text>
      {errView}
      {state === 'FAILED_RETURNING' ? <TouchableOpacity onPress={returned} disabled={busy} accessibilityRole="button" style={[st.cta, { backgroundColor: accent }]}>{busy ? <ActivityIndicator color="#080C18" /> : <Text style={st.ctaTxt}>Parcel returned to sender</Text>}</TouchableOpacity> : null}
    </View>
  );

  if (state === 'LOCKED') return <View style={card}><Text style={[st.title, { color: RED }]}>Delivery locked</Text><Text style={{ color: theme.hint }}>Too many wrong codes. Contact Runserv support to continue or report a failed delivery.</Text></View>;

  return (
    <View style={card}>
      <Text style={[st.title, { color: theme.foreground }]}>{mode === 'code' ? 'Proof of delivery' : 'Report failed delivery'}</Text>
      {mode === 'code' ? (
        <>
          <Text style={{ color: theme.hint, marginBottom: 10 }}>Ask the recipient for their 6-digit code, then take a photo of the hand-over.</Text>
          <View style={[st.box, { backgroundColor: theme.background, borderColor: error ? RED : theme.border }]}>
            <Ionicons name="keypad-outline" size={16} color={theme.hint} />
            <TextInput value={code} onChangeText={(v) => { setCode(cleanCode(v)); setError(null); setConfirming(false); }} keyboardType="number-pad" maxLength={6} placeholder="••••••" placeholderTextColor={theme.hint}
              style={{ flex: 1, color: theme.foreground, fontSize: 20, letterSpacing: 6, fontWeight: '800', paddingVertical: 10 }} accessibilityLabel="Recipient code" editable={!busy} />
          </View>
          {photoRow}
          {errView}
          {!confirming ? (
            <TouchableOpacity onPress={() => setConfirming(true)} disabled={!isRecipientCode(code) || busy} accessibilityRole="button" style={[st.cta, { backgroundColor: accent, opacity: isRecipientCode(code) ? 1 : 0.45 }]}><Text style={st.ctaTxt}>Review hand-over</Text></TouchableOpacity>
          ) : (
            <View style={[st.summary, { borderColor: theme.border }]}>
              <Text style={{ color: theme.foreground, fontWeight: '700' }}>Confirm hand-over</Text>
              <Text style={{ color: theme.hint, fontSize: 12, marginVertical: 4 }}>Code {code.replace(/^(\d{3})(\d{3})$/, '$1 $2')} · {photo ? 'photo attached' : 'no photo'}</Text>
              <TouchableOpacity onPress={confirmHandover} disabled={busy} accessibilityRole="button" style={[st.cta, { backgroundColor: accent }]}>{busy ? <ActivityIndicator color="#080C18" /> : <Text style={st.ctaTxt}>{upload === 'failed' ? 'Retry upload and confirm' : 'Confirm hand-over'}</Text>}</TouchableOpacity>
            </View>
          )}
          <TouchableOpacity onPress={() => { setMode('failed'); setError(null); }} accessibilityRole="button" style={{ marginTop: 12 }}><Text style={{ color: RED, fontWeight: '700' }}>Could not deliver the parcel?</Text></TouchableOpacity>
        </>
      ) : (
        <>
          {FAIL_REASONS.map((r) => (
            <TouchableOpacity key={r.code} onPress={() => { setReason(r.code); setError(null); }} accessibilityRole="radio" accessibilityState={{ selected: reason === r.code }}
              style={[st.reason, { borderColor: reason === r.code ? accent : theme.border, backgroundColor: reason === r.code ? accent + '18' : theme.background }]}>
              <Ionicons name={reason === r.code ? 'radio-button-on' : 'radio-button-off'} size={18} color={reason === r.code ? accent : theme.hint} />
              <Text style={{ color: theme.foreground, flex: 1 }}>{r.label}</Text>
            </TouchableOpacity>
          ))}
          <View style={[st.box, { backgroundColor: theme.background, borderColor: theme.border, marginTop: 6 }]}>
            <TextInput value={note} onChangeText={setNote} placeholder="Note for support (optional)" placeholderTextColor={theme.hint} style={{ flex: 1, color: theme.foreground, paddingVertical: 10 }} maxLength={300} accessibilityLabel="Note" editable={!busy} />
          </View>
          {photoRow}
          {errView}
          <TouchableOpacity onPress={submitFailure} disabled={busy || !reason} accessibilityRole="button" style={[st.cta, { backgroundColor: RED, opacity: reason ? 1 : 0.45 }]}>{busy ? <ActivityIndicator color="#fff" /> : <Text style={[st.ctaTxt, { color: '#fff' }]}>Report failed delivery</Text>}</TouchableOpacity>
          <TouchableOpacity onPress={() => { setMode('code'); setError(null); }} accessibilityRole="button" style={{ marginTop: 12 }}><Text style={{ color: theme.hint, fontWeight: '700' }}>Back to code entry</Text></TouchableOpacity>
        </>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  card: { borderWidth: 1, borderRadius: 16, padding: 14, marginBottom: 14 },
  title: { fontSize: 15, fontWeight: '800', marginBottom: 6 },
  box: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 12, marginBottom: 10 },
  photoBtn: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1, borderRadius: 12, padding: 10 },
  thumb: { width: 40, height: 40, borderRadius: 8 },
  cta: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', minHeight: 48 },
  ctaTxt: { color: '#080C18', fontWeight: '800', fontSize: 14 },
  summary: { borderWidth: 1, borderRadius: 12, padding: 12 },
  reason: { flexDirection: 'row', alignItems: 'center', gap: 10, borderWidth: 1.5, borderRadius: 12, padding: 12, marginBottom: 6 },
});
