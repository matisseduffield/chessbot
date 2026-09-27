import { it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { sizeOverlay } from './overlaySurface';

it('keeps foreground and background aligned when reused after a resize', () => {
  const doc = new JSDOM('<svg></svg>').window.document;
  const svg = doc.querySelector('svg');
  sizeOverlay(svg, { width: 480, height: 480 });
  expect(svg.style.width).toBe('100%');
  expect(svg.getAttribute('viewBox')).toBe('0 0 480 480');
  sizeOverlay(svg, { width: 640, height: 640 }, 2, 3);
  expect(svg.getAttribute('viewBox')).toBe('0 0 640 640');
  expect(svg.style.left).toBe('2px');
  expect(svg.style.top).toBe('3px');
});
