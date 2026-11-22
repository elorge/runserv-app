// MTN MoMo pay sheet: phone number → "approve on your phone" → live status. Used AFTER a booking exists.
//
// Props: visible, onClose, rideId | deliveryId, defaultPhone, amountLabel (already formatted), theme, onPaid().
import React, { useEffect, useRef, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { newIdempotencyKey, startMomoPayment, waitForMomo } from '../services/momoPayment';

const FINAL_COPY = {
  COMPLETED: { title: 'Payment received', body: 'Your MTN MoMo payment was successful.' },
  FAILED: { title: 'Payment not completed', body: 'The payment was declined or cancelled. You have not been charged. You can try again.' },
  CANCELLED: { title: 'Payment cancelled', body: 'The payment was cancelled. You can try again.' },
  EXPIRED: { title: 'Payment expired', body: 'The request expired before it was approved. You can try again.' },
  REVIEW_REQUIRED: { title: 'We are checking your payment', body: 'Please do not pay again. We will confirm this payment shortly and notify you.' },
};

const MomoPayModal = ({ visible, onClose, rideId, deliveryId, defaultPhone = '', amountLabel, theme, onPaid }) => {
  const [phone, setPhone] = useState(defaultPhone);
  const [phase, setPhase] = useState('enter');          // enter | waiting | done
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState(null);
  const attempt = useRef(null);                         // { key, paymentId, reference } — one key per attempt
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { if (visible) { setPhase('enter'); setError(''); setOutcome(null); attempt.current = null; setPhone(defaultPhone); } }, [visible, defaultPhone]);

  const pay = async () => {
    setError('');
    if (phone.replace(/\D/g, '').length < 7) { setError('Enter a valid MTN number.'); return; }
    setPhase('waiting');
    try {
      // Re-tapping after a dropped connection reuses the same key, so the customer is never charged twice.
      if (!attempt.current) attempt.current = { key: newIdempotencyKey() };
      const started = await startMomoPayment({ rideId, deliveryId, phone, idempotencyKey: attempt.current.key });
      attempt.current = { ...attempt.current, paymentId: started.paymentId, reference: started.reference };
      const r = await waitForMomo({ paymentId: started.paymentId });
      if (!alive.current) return;
      if (r.timedOut) { setPhase('enter'); setError('We have not seen your approval yet. Approve the prompt on your phone, then tap “Check again”.'); return; }
      setOutcome(r.status); setPhase('done');
      if (r.status === 'COMPLETED') onPaid?.();
    } catch (e) {
      if (!alive.current) return;
      attempt.current = null;                           // a clean refusal → next attempt gets a fresh key
      setError(e?.message || 'Something went wrong.'); setPhase('enter');
    }
  };

  const checkAgain = async () => {
    if (!attempt.current?.paymentId) return pay();
    setPhase('waiting'); setError('');
    const r = await waitForMomo({ paymentId: attempt.current.paymentId, attempts: 10 }).catch((e) => ({ error: e }));
    if (!alive.current) return;
    if (r.error) { setError(r.error.message); setPhase('enter'); return; }
    if (r.timedOut) { setPhase('enter'); setError('Still waiting for your approval.'); return; }
    setOutcome(r.status); setPhase('done'); if (r.status === 'COMPLETED') onPaid?.();
  };

  const copy = FINAL_COPY[outcome] || { title: '', body: '' };
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={phase === 'waiting' ? undefined : onClose}>
      <View style={s.backdrop}>
        <View style={[s.sheet, { backgroundColor: theme?.background ?? '#fff' }]}>
          <Text style={[s.title, { color: theme?.foreground ?? '#111' }]}>Pay with MTN MoMo</Text>
          {phase === 'enter' && (<>
            {!!amountLabel && <Text style={[s.sub, { color: theme?.hint ?? '#666' }]}>Amount: {amountLabel}</Text>}
            <TextInput style={[s.input, { borderColor: theme?.border ?? '#ccc', color: theme?.foreground ?? '#111' }]} keyboardType="phone-pad" value={phone} onChangeText={setPhone} placeholder="MTN phone number" placeholderTextColor={theme?.hint ?? '#999'} maxLength={20} />
            {!!error && <Text style={s.error}>{error}</Text>}
            <TouchableOpacity style={s.btn} onPress={attempt.current?.paymentId ? checkAgain : pay} accessibilityRole="button"><Text style={s.btnTxt}>{attempt.current?.paymentId ? 'Check again' : 'Send payment request'}</Text></TouchableOpacity>
            <TouchableOpacity onPress={onClose}><Text style={[s.link, { color: theme?.hint ?? '#666' }]}>Cancel</Text></TouchableOpacity>
          </>)}
          {phase === 'waiting' && (<View style={{ alignItems: 'center', paddingVertical: 24 }}><ActivityIndicator /><Text style={[s.sub, { marginTop: 12, color: theme?.hint ?? '#666' }]}>Approve the payment prompt on your phone…</Text></View>)}
          {phase === 'done' && (<>
            <Text style={[s.doneTitle, { color: theme?.foreground ?? '#111' }]}>{copy.title}</Text>
            <Text style={[s.sub, { color: theme?.hint ?? '#666' }]}>{copy.body}</Text>
            <TouchableOpacity style={s.btn} onPress={onClose}><Text style={s.btnTxt}>Done</Text></TouchableOpacity>
          </>)}
        </View>
      </View>
    </Modal>
  );
};

const s = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.45)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 32 },
  title: { fontSize: 18, fontWeight: '700', marginBottom: 8 },
  doneTitle: { fontSize: 16, fontWeight: '700', marginBottom: 6 },
  sub: { fontSize: 13, lineHeight: 19, marginBottom: 12 },
  input: { borderWidth: 1, borderRadius: 12, padding: 12, fontSize: 16, marginBottom: 8 },
  error: { color: '#E05555', fontSize: 12, marginBottom: 8 },
  btn: { backgroundColor: '#FFCC00', borderRadius: 12, padding: 14, alignItems: 'center', marginTop: 4 },
  btnTxt: { color: '#111', fontWeight: '700', fontSize: 14 },
  link: { textAlign: 'center', marginTop: 14, fontSize: 13 },
});

export default MomoPayModal;
