// mobile/src/utils/orgErrors.js
// Turns organisation (ORG_*) booking errors into a helpful next step instead of a dead end.
import { Alert } from 'react-native';
import { corporateAPI } from '../services/api';
import { clearOrgCache } from '../hooks/useOrgAccount';

/**
 * @param err      the rejected API error ({ message, code, details })
 * @param ctx      { serviceType, pickupAddress, dropoffAddress, estimatedFare, distanceKm, payerChoice, onPaySelf }
 * @returns true if the error was handled (an alert was shown)
 */
export const handleOrgBookingError = (err, ctx) => {
  const code = err?.code;
  if (!code || !String(code).startsWith('ORG_')) return false;

  if (code === 'ORG_APPROVAL_REQUIRED') {
    Alert.alert('Manager approval needed', `${err.message}\n\nWe’ll send this trip to your manager. You’ll get a notification as soon as they decide, then you can book it.`, [
      { text: 'Not now', style: 'cancel' },
      { text: 'Pay myself', onPress: () => ctx.onPaySelf?.() },
      { text: 'Ask my manager', onPress: async () => {
        try {
          await corporateAPI.requestApproval({
            serviceType: ctx.serviceType, pickupAddress: ctx.pickupAddress, dropoffAddress: ctx.dropoffAddress, estimatedFare: ctx.estimatedFare,
            distanceKm: ctx.distanceKm ?? undefined, purpose: ctx.payerChoice?.purpose || undefined, purposeCategory: ctx.payerChoice?.purposeCategory || undefined,
          });
          clearOrgCache();
          Alert.alert('Sent', 'Your manager has been asked to approve this trip.');
        } catch (e) { Alert.alert('Could not send the request', e?.message ?? 'Please try again.'); }
      } },
    ]);
    return true;
  }

  // Everything else (weekend, limits, budget, funds, overdue…): explain, and offer to pay personally.
  Alert.alert('Can’t use the company account for this trip', err.message, [
    { text: 'OK', style: 'cancel' },
    { text: 'Pay myself', onPress: () => ctx.onPaySelf?.() },
  ]);
  return true;
};
