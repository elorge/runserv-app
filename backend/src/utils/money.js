// backend/src/utils/money.js
//
// Integer minor-unit arithmetic for partner settlements (blueprint §8.1: never use floating point
// for financial balances). Prisma Decimal columns hold the 2-dp value; all calculation happens in
// integer minor units (kobo/pesewas) and rates in millionths, using BigInt for the multiply.
'use strict';

const toNumber = (v) => (v === null || v === undefined || v === '' ? 0 : Number(typeof v === 'object' ? v.toString() : v));

/** 1234.56 | "1234.56" | Decimal → 123456 */
const toMinor = (v) => Math.round(toNumber(v) * 100);
/** 123456 → 1234.56 (a Number safe to store in a Decimal(14,2) column) */
const fromMinor = (m) => Number((m / 100).toFixed(2));
/** 0.105 | "0.105000" | Decimal → 105000 (parts per million) */
const rateToPpm = (rate) => Math.round(toNumber(rate) * 1e6);

/**
 * Platform fee on a fare. Rounds half-up to the nearest minor unit.
 * @returns {{ fareMinor:number, feeMinor:number, netMinor:number }}
 */
const splitFareMinor = (fareMinor, rate) => {
  if (!Number.isInteger(fareMinor) || fareMinor < 0) throw new Error('fareMinor must be a non-negative integer');
  const ppm = rateToPpm(rate);
  if (ppm < 0 || ppm > 1e6) throw new Error('commission rate must be between 0 and 1');
  const feeMinor = Number((BigInt(fareMinor) * BigInt(ppm) + 500000n) / 1000000n);
  return { fareMinor, feeMinor, netMinor: fareMinor - feeMinor };
};

/** Convenience: decimal in, decimals out. */
const splitFare = (fare, rate) => {
  const s = splitFareMinor(toMinor(fare), rate);
  return { fare: fromMinor(s.fareMinor), platformFee: fromMinor(s.feeMinor), net: fromMinor(s.netMinor) };
};

module.exports = { toMinor, fromMinor, rateToPpm, splitFareMinor, splitFare };
