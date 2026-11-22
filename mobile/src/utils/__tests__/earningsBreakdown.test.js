import { driverTrip, courierRun, payoutBreakdown } from '../earningsEstimate';

describe('payoutBreakdown reconciles', () => {
  it('driver: fare - booking fee - commission = payout for many distances/vehicles/multipliers', () => {
    for (const vehicleType of ['CAR', 'MOTORCYCLE', 'VAN', 'TRICYCLE']) {
      for (const km of [1, 3, 6, 12, 25]) {
        for (const multiplier of [1, 1.1, 1.3]) {
          const t = driverTrip({ km, vehicleType, multiplier });
          const b = payoutBreakdown('DRIVER', t);
          expect(b.fare - b.bookingFee - b.commission).toBe(b.payout);
          expect(b.reconciles).toBe(true);
          expect(b.commission).toBeGreaterThanOrEqual(0);
        }
      }
    }
  });
  it('courier: fee - commission = payout', () => {
    for (const parcel of ['DOCUMENT', 'SMALL', 'MEDIUM', 'LARGE']) {
      for (const km of [1, 6, 30]) {
        const b = payoutBreakdown('COURIER', courierRun({ km, parcel }));
        expect(b.bookingFee).toBe(0);
        expect(b.fare - b.commission).toBe(b.payout);
        expect(b.commissionRate).toBeCloseTo(0.15);
      }
    }
  });
});
