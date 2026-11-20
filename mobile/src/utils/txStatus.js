// mobile/src/utils/txStatus.js
//
// Turns the raw WalletTransaction.status coming from the backend
// (PENDING / COMPLETED / FAILED / REJECTED ...) into a user-friendly
// label + colour. Used by the wallet screen and the transaction history.
//
// Top-ups (a CREDIT that came through a payment provider) read "Approved"
// once credited; every other completed transaction reads "Completed".

const GREEN = '#5DAA72';
const GOLD  = '#0092F5';
const RED   = '#E05555';
const GREY  = '#8A8A8A';

export const getTxStatus = (item, t) => {
  const raw = String(item?.status ?? '').toUpperCase();
  const isTopUp = item?.type === 'CREDIT' && !!item?.provider;
  const tr = (key, fallback) => (t ? t(key, { defaultValue: fallback }) : fallback);

  switch (raw) {
    case 'COMPLETED':
      return isTopUp
        ? { label: tr('txStatus.approved', 'Approved'),  color: GREEN }
        : { label: tr('txStatus.completed', 'Completed'), color: GREEN };
    case 'PENDING':
    case 'PROCESSING':
      return { label: tr('txStatus.pending', 'Pending'), color: GOLD };
    case 'FAILED':
      return { label: tr('txStatus.failed', 'Failed'), color: RED };
    case 'REJECTED':
      return { label: tr('txStatus.rejected', 'Rejected'), color: RED };
    case 'CANCELLED':
      return { label: tr('txStatus.cancelled', 'Cancelled'), color: GREY };
    default:
      return { label: raw || '—', color: GREY };
  }
};
