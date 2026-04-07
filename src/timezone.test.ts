import { describe, expect, it } from 'vitest';

import { formatDisplayDateTime } from './timezone.js';

describe('formatDisplayDateTime', () => {
  it('formats UTC iso timestamps into compact product-style local time', () => {
    expect(
      formatDisplayDateTime('2026-04-05T12:00:00.000Z', 'Asia/Shanghai'),
    ).toBe('2026/04/05 20:00 (Asia/Shanghai)');
  });
});
