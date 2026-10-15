import { describe, expect, it } from 'vitest';
import { metadataHintPosition } from '../src/role-metadata-hint';

describe('anchored metadata hints', () => {
  it('opens above a phrase near the bottom of a phone', () => {
    const result = metadataHintPosition({ x: 290, y: 740, width: 80, height: 44 }, { width: 390, height: 844 }, 220);
    expect(result.placement).toBe('above');
    expect(result.top + 220).toBeLessThan(740);
    expect(result.left + result.width).toBeLessThanOrEqual(378);
    expect(result.left + result.arrowLeft).toBe(330);
  });
  it('opens below a phrase near the top and keeps the pointer attached', () => {
    const result = metadataHintPosition({ x: 14, y: 12, width: 60, height: 44 }, { width: 390, height: 844 }, 140);
    expect(result.placement).toBe('below');
    expect(result.top).toBe(64);
    expect(result.left).toBeGreaterThanOrEqual(12);
    expect(result.left + result.arrowLeft).toBe(44);
  });
  it('bounds long details to the available space in a short landscape viewport', () => {
    const result = metadataHintPosition({ x: 700, y: 130, width: 100, height: 44 }, { width: 844, height: 260 }, 600);
    expect(result.maxHeight).toBeLessThanOrEqual(110);
    expect(result.top).toBeGreaterThanOrEqual(12);
    expect(result.left + result.width).toBeLessThanOrEqual(832);
  });
  it.each([240, 320, 390, 768, 1440])('fits a %i pixel viewport without horizontal scrolling', width => {
    for (const x of [0, width / 2, width - 30]) {
      const result = metadataHintPosition({ x, y: 200, width: 30, height: 44 }, { width, height: 600 }, 200);
      expect(result.left).toBeGreaterThanOrEqual(12);
      expect(result.left + result.width).toBeLessThanOrEqual(width - 12);
      expect(result.arrowLeft).toBeGreaterThanOrEqual(16);
      expect(result.arrowLeft).toBeLessThanOrEqual(result.width - 16);
    }
  });
});
