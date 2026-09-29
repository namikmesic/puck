/**
 * NDJSON over a runner channel: a multi-byte UTF-8 character split across
 * two reads must survive as the original string, on both ends of the channel.
 */

import { describe, expect, it } from 'vitest';
import { BaseChannel, lines } from '../../src/main/runners/channel';
import type { Control } from '../../src/puck-runner/control';
import { controlEndpoint } from '../../src/puck-runner/endpoints';
import { nullLogger } from '../../src/puck-runner/log';

class MemChannel extends BaseChannel {
  protected send(): boolean {
    return true;
  }
  protected teardown(): void {
    /* nothing to release */
  }
  push(chunk: Buffer): void {
    this.deliver(chunk, () => undefined);
  }
}

/** Index just after the lead byte of the first multi-byte character. */
function splitInsideMultibyte(bytes: Buffer): number {
  for (let i = 0; i < bytes.length - 1; i++) {
    const b = bytes[i];
    if ((b & 0xe0) === 0xc0 || (b & 0xf0) === 0xe0 || (b & 0xf8) === 0xf0) return i + 1;
  }
  throw new Error('payload has no multi-byte character');
}

const text = 'café — 日本語';

describe('NDJSON UTF-8', () => {
  it('keeps a character split across chunks in the parsed JSON string', () => {
    const channel = new MemChannel();
    const parsed: { text: string }[] = [];
    lines(channel, 1024 * 1024, (line) => parsed.push(JSON.parse(line) as { text: string }));
    const bytes = Buffer.from(JSON.stringify({ text }) + '\n', 'utf8');
    const at = splitInsideMultibyte(bytes);
    channel.push(bytes.subarray(0, at));
    expect(parsed).toEqual([]);
    channel.push(bytes.subarray(at));
    expect(parsed).toEqual([{ text }]);
  });

  it('keeps a character split across chunks in a control command', () => {
    const seen: unknown[] = [];
    const endpoint = controlEndpoint({
      control: {
        handle: (frame) => {
          seen.push(frame);
          return Promise.resolve({ t: 'res', id: 'c1', ok: true, result: {} });
        },
      } as unknown as Control,
      runnerId: 'rnr_x',
      version: '0.1.0',
      sink: { write: () => true, close: () => undefined },
      log: nullLogger,
    });
    const frame = { t: 'cmd', id: 'c1', op: 'instance.create', args: { note: text } };
    const bytes = Buffer.from(JSON.stringify(frame) + '\n', 'utf8');
    const at = splitInsideMultibyte(bytes);
    endpoint.data(bytes.subarray(0, at), () => undefined);
    expect(seen).toEqual([]);
    endpoint.data(bytes.subarray(at), () => undefined);
    expect(seen).toEqual([frame]);
  });
});
