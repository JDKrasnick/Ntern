import { expect, it, vi } from 'vitest';
import { compensationLabels, compactCompensationLabel } from '../shared/compensation-display.js';

const pay = { minAmount: 37, maxAmount: 37, currency: 'USD', period: 'hourly', sourceText: 'Compensation Hourly Rate : $37.00' };
const symbolPay = { ...pay, currency: 'XXX', sourceText: 'Hourly Rate : $37.00' };

it('shows a matching typed and symbol-only pay disclosure once, regardless of source order', () => {
  for (const ranges of [[pay, symbolPay], [symbolPay, pay], [pay, pay, symbolPay]]) {
    expect(compensationLabels({ ranges })).toEqual(['USD 37/hour']);
    expect(compactCompensationLabel({ ranges })).toBe('$37/hr');
  }
});

it('preserves distinct currencies, pay bands, cadence, and applicability', () => {
  for (const distinct of [
    { ...symbolPay, minAmount: 40, maxAmount: 45 },
    { ...symbolPay, period: 'daily' },
    { ...symbolPay, applicableLocations: ['Toronto'] },
    { ...symbolPay, applicableEducationLevels: ['masters'] },
    { ...symbolPay, applicabilityLabel: 'If eligible' },
    { ...symbolPay, sourceText: 'Another program pays $37.00 per hour' },
    { ...symbolPay, sourceText: 'Hourly Rate : €37.00' },
    { ...symbolPay, sourceText: undefined },
    { ...pay, currency: 'CAD' },
  ]) {
    expect(compensationLabels({ ranges: [pay, distinct] })).toHaveLength(2);
    expect(compactCompensationLabel({ ranges: [pay, distinct] })).toBe('Pay varies');
  }
  expect(compensationLabels({ ranges: [pay, { ...pay, currency: 'CAD' }, symbolPay] }))
    .toEqual(['USD 37/hour', 'CAD 37/hour', '$37/hour']);
  expect(compensationLabels({ ranges: [symbolPay, { ...symbolPay, sourceText: 'Hourly Rate : €37.00' }] }))
    .toEqual(['$37/hour', '€37/hour']);
});

it('formats repeated pay ranges without allocating a native formatter for each amount', () => {
  const constructors = vi.spyOn(Intl, 'NumberFormat');
  try {
    for (let index = 0; index < 1_000; index += 1) {
      const annual = { ranges: [{ minAmount: 123_456, maxAmount: 180_999, currency: 'USD', period: 'annual' }] };
      expect(compensationLabels(annual)).toEqual(['USD 123,456–180,999/year']);
      expect(compactCompensationLabel(annual)).toBe('$123.5K–$181K/yr');
      expect(compactCompensationLabel({ ranges: [{ minAmount: 54.25, maxAmount: 60.5, currency: 'USD', period: 'hourly' }] })).toBe('$54–$61/hr');
    }
    expect(constructors).not.toHaveBeenCalled();
  } finally { constructors.mockRestore(); }
});
