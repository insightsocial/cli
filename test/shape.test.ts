import { describe, expect, it } from 'vitest';

import { JqError, capItems, pickFields, shape, summarize } from '../src/shape.js';
import { postsEnvelope } from './fixtures.js';

describe('shape', () => {
  const envelope = postsEnvelope();

  it('caps items with a marker', () => {
    const out = capItems(envelope.data, 2) as { items: unknown[] };
    expect(out.items).toHaveLength(3);
    expect(out.items[2]).toEqual({ _truncated: '10 more item(s) not shown' });
  });

  it('picks dotted fields on each item', async () => {
    const out = (await shape(envelope.data, { fields: ['post.id', 'post.engagement.likes'], maxItems: 1 })) as { items: unknown[] };
    expect(out.items[0]).toEqual({ post: { id: 'p0', engagement: { likes: 0 } } });
  });

  it('explains when no field matched', async () => {
    const out = (await shape(envelope.data, { fields: ['id'] })) as { items: { _note: string }[] };
    expect(out.items[0]?._note).toContain('Top-level item keys: post, computed');
  });

  it('runs jq and unwraps a single output', async () => {
    expect(await shape(envelope, { jq: '[.data.items[].post.engagement.likes] | add' })).toBe(660);
    expect(await shape(envelope, { jq: '.data.items[0:2][] | .post.id' })).toEqual(['p0', 'p1']);
  });

  it('raises JqError on a bad expression', async () => {
    await expect(shape(envelope, { jq: '.[' })).rejects.toBeInstanceOf(JqError);
  });

  it('summarizes with sizes and nested keys', () => {
    const out = summarize(envelope) as { data: { items: { _type: string; _item: { post: { id: string } } } } };
    expect(out.data.items._type).toBe('array[12]');
    expect(out.data.items._item.post.id).toBe('p0');
  });

  it('leaves non-record items alone', () => {
    expect(pickFields('x', ['a'])).toBe('x');
  });
});

