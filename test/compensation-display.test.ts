import { expect, it, vi } from 'vitest';
import { compensationLabels, compactCompensationLabel } from '../shared/compensation-display.js';

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
