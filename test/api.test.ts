import { describe, expect, it } from 'vitest';

import { ApiError, chargeLine } from '../src/api.js';

describe('ApiError hints for schema 2', () => {
  it('names the refused parameter', () => {
    const e = new ApiError(400, 'UNSUPPORTED_PARAMETER', 'not supported', 'req_1', undefined, 'relevance');
    expect(e.param).toBe('relevance');
    expect(e.hint).toContain('Remove "relevance" and retry');
  });

  it('restarts a bad or expired cursor, and moves a cursor sent under the wrong name', () => {
    for (const type of ['CURSOR_INVALID', 'CURSOR_EXPIRED']) {
      expect(new ApiError(400, type, 'x', undefined, undefined, 'cursor').hint).toContain('Restart without cursor');
    }
    expect(new ApiError(400, 'CURSOR_INVALID', 'x', undefined, undefined, 'next_max_id').hint).toBe(
      'Send pagination.next_cursor as "cursor", not as "next_max_id".',
    );
  });

  it('covers the other new types', () => {
    expect(new ApiError(503, 'UPSTREAM_INVALID', 'x').hint).toContain('retry shortly');
    expect(new ApiError(409, 'IDEMPOTENCY_KEY_REUSED', 'x').hint).toContain('new key');
    expect(new ApiError(409, 'IDEMPOTENCY_REPLAY_UNAVAILABLE', 'x').hint).toContain('is charged');
    expect(new ApiError(405, 'METHOD_NOT_SUPPORTED', 'x').hint).toContain('insightsocial search');
  });
});

describe('chargeLine', () => {
  it('says why a call cost what it did', () => {
    expect(chargeLine({ charge_reason: 'miss', free_call: true })).toBe('miss, free call');
    expect(chargeLine({ charge_reason: 'shared_cache', free_call: false })).toBe('shared_cache');
    expect(chargeLine({ charge_reason: 'dry_run' })).toBe('dry_run');
    expect(chargeLine({})).toBeUndefined();
  });
});
