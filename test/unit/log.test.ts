import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger, LOG_FILE, log, logDir, redact } from '../../src/main/log';

const dirs: string[] = [];
const tempDir = (): string => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'puck-log-')), 'logs');
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(path.dirname(dir), { recursive: true, force: true });
});

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const LONG = 'A'.repeat(20) + 'b1'.repeat(20) + '_-=';

describe('redact', () => {
  it('replaces the value of credential-looking keys in JSON, yaml, and env shapes', () => {
    expect(redact('{"access_token":"abc123","refresh_token": "def"}')).toBe(
      '{"access_token":[redacted],"refresh_token": [redacted]}',
    );
    expect(redact('apiKey=sk-live-1234 next=ok')).toBe('apiKey=[redacted] next=ok');
    expect(redact("password: 'hunter2', user: 'x'")).toBe("password: [redacted], user: 'x'");
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: [redacted]');
  });

  it('scrubs bare token shapes wherever they appear', () => {
    expect(redact('sent Bearer abc.DEF-123 to the API')).toBe('sent Bearer [redacted] to the API');
    expect(redact('key sk-ant-api03-abcdefghijklmnop rejected')).toBe('key [redacted] rejected');
    expect(redact(`saw ${JWT} in body`)).toBe('saw [redacted-jwt] in body');
    expect(redact(`blob ${LONG} end`)).toBe('blob [redacted-long] end');
  });

  it('leaves ordinary diagnostics alone', () => {
    const plain =
      'env.start {"envId":"6f3c2a10-1b2c-4d5e-8f90-1234567890ab","image":"node:22-bookworm"} token expired: 401 at /Users/x/Library/Application Support/Puck/puck-agents.json';
    expect(redact(plain)).toBe(plain);
  });
});

describe('createLogger', () => {
  it('writes one record per call, ISO timestamp first, fields as JSON, errors with an indented stack', () => {
    const dir = tempDir();
    const clock = new Date('2026-09-23T16:00:00.000Z');
    const logger = createLogger({ dir, now: () => clock });
    logger.info('app.ready', { version: '0.0.1' });
    logger.warn('env.slow');
    const err = new Error('docker start failed');
    logger.error('env.start.failed', err, { envId: 'env-1' });

    const text = fs.readFileSync(logger.file(), 'utf8');
    const records = text.split('\n2026-').length;
    expect(records).toBe(3);
    expect(text).toContain('2026-09-23T16:00:00.000Z INFO  app.ready {"version":"0.0.1"}\n');
    expect(text).toContain('2026-09-23T16:00:00.000Z WARN  env.slow\n');
    expect(text).toContain('ERROR env.start.failed {"envId":"env-1"} :: Error: docker start failed\n  at ');
    expect(logger.file()).toBe(path.join(dir, LOG_FILE));
  });

  it('never writes a credential, in a message, in fields, or in an error', () => {
    const dir = tempDir();
    const logger = createLogger({ dir });
    logger.info(`login landed with Bearer ${LONG}`);
    logger.warn('token refresh', { access_token: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz', expires: 3600 });
    logger.error('exchange failed', new Error(`server said ${JWT}`), { refresh_token: 'rt-1' });
    const text = fs.readFileSync(logger.file(), 'utf8');
    expect(text).not.toContain(LONG);
    expect(text).not.toContain('sk-ant');
    expect(text).not.toContain(JWT);
    expect(text).not.toContain('rt-1');
    expect(text).toContain('"expires":3600'); // non-secret fields survive
  });

  it('rotates at the size cap and keeps a bounded number of files, oldest dropped', () => {
    const dir = tempDir();
    const logger = createLogger({ dir, maxBytes: 300, keep: 3, now: () => new Date(0) });
    for (let i = 0; i < 60; i++) logger.info(`line-${String(i).padStart(3, '0')}`);

    const files = logger.files();
    expect(files).toEqual([path.join(dir, LOG_FILE), path.join(dir, `${LOG_FILE}.1`), path.join(dir, `${LOG_FILE}.2`)]);
    expect(fs.readdirSync(dir).length).toBe(3);
    for (const f of files) expect(fs.statSync(f).size).toBeLessThanOrEqual(300);

    const all = files.map((f) => fs.readFileSync(f, 'utf8'));
    expect(all[0]).toContain('line-059'); // the newest line is in the current file
    expect(all.join('')).not.toContain('line-000'); // the oldest lines are gone
    // Order is preserved across the ladder: .2 is older than .1 is older than current.
    const first = (text: string): number => Number(/line-(\d+)/.exec(text)?.[1]);
    expect(first(all[2])).toBeLessThan(first(all[1]));
    expect(first(all[1])).toBeLessThan(first(all[0]));
  });

  it('resumes the size count from an existing file across restarts', () => {
    const dir = tempDir();
    const a = createLogger({ dir, maxBytes: 120, keep: 2, now: () => new Date(0) });
    a.info('x.'.repeat(30)); // 60 bytes, and not a token-shaped blob
    const b = createLogger({ dir, maxBytes: 120, keep: 2, now: () => new Date(0) });
    b.info('y.'.repeat(30)); // 60 + 60 + two headers > 120: must rotate, not overflow
    expect(fs.existsSync(path.join(dir, `${LOG_FILE}.1`))).toBe(true);
    expect(fs.readFileSync(b.file(), 'utf8')).toContain('y.y.');
  });

  it('mirrors warn and error to the console when asked, never info', () => {
    const dir = tempDir();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const logger = createLogger({ dir, mirror: true });
    logger.info('quiet');
    logger.warn('loud');
    logger.error('louder', new Error('boom'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('louder');
    error.mockRestore();
    warn.mockRestore();
  });

  it('swallows write failures instead of throwing into the app', () => {
    const parent = tempDir();
    fs.mkdirSync(path.dirname(parent), { recursive: true });
    fs.writeFileSync(parent, 'not a directory'); // the log dir path is a file
    const logger = createLogger({ dir: parent });
    expect(() => logger.error('lost', new Error('x'))).not.toThrow();
    expect(logger.files()).toEqual([]);
  });
});

describe('app logger', () => {
  it('lives under userData/logs and only touches disk on first use', () => {
    expect(fs.existsSync(logDir())).toBe(false);
    log.info('app.ready');
    expect(log.file()).toBe(path.join(logDir(), LOG_FILE));
    expect(fs.readFileSync(log.file(), 'utf8')).toContain('INFO  app.ready');
  });
});
