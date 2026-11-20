jest.mock('../vehicleIconData', () => ({ VEHICLE_ICON_DATA: { car_blue: 'data:a', van: 'data:b' } }));
jest.mock('../../../assets/vehicles/car_blue.png', () => 1, { virtual: true });
jest.mock('../../../assets/vehicles/car_white.png', () => 2, { virtual: true });
jest.mock('../../../assets/vehicles/car_black.png', () => 3, { virtual: true });
jest.mock('../../../assets/vehicles/van.png', () => 4, { virtual: true });
jest.mock('../../../assets/vehicles/motorcycle.png', () => 5, { virtual: true });
jest.mock('../../../assets/vehicles/bike.png', () => 6, { virtual: true });
jest.mock('../../../assets/vehicles/tricycle.png', () => 7, { virtual: true });
jest.mock('../../../assets/vehicles/tricycle_cargo.png', () => 8, { virtual: true });
jest.mock('../../../assets/vehicles/van_cargo.png', () => 9, { virtual: true });

const { resolveVehicleIconKey, smoothHeading, metresBetween } = require('../vehicleIcons');

describe('resolveVehicleIconKey', () => {
  it('maps every backend VehicleType', () => {
    expect(resolveVehicleIconKey('CAR')).toBe('car_blue');
    expect(resolveVehicleIconKey('car', { colour: 'black' })).toBe('car_black');
    expect(resolveVehicleIconKey('MOTORCYCLE')).toBe('motorcycle');
    expect(resolveVehicleIconKey('BIKE')).toBe('bike');
    expect(resolveVehicleIconKey('TRICYCLE')).toBe('tricycle');
    expect(resolveVehicleIconKey('TRICYCLE', { cargo: true })).toBe('tricycle_cargo');
    expect(resolveVehicleIconKey('VAN', { cargo: true })).toBe('van_cargo');
  });
  it('falls back to the blue car', () => {
    expect(resolveVehicleIconKey(undefined)).toBe('car_blue');
    expect(resolveVehicleIconKey('SPACESHIP')).toBe('car_blue');
  });
});

describe('smoothHeading', () => {
  it('turns the short way round north', () => {
    expect(smoothHeading(350, 10)).toBe(370);
    expect(smoothHeading(10, 350)).toBe(-10);
  });
  it('starts at the first bearing', () => { expect(smoothHeading(null, 90)).toBe(90); });
});

describe('metresBetween', () => {
  it('is ~111 m per 0.001 degree of latitude', () => {
    expect(Math.round(metresBetween(6.5, 3.3, 6.501, 3.3))).toBeGreaterThan(105);
    expect(Math.round(metresBetween(6.5, 3.3, 6.501, 3.3))).toBeLessThan(118);
  });
});
