/**
 * The relay wire contract shared by the Puck server, runners and the app.
 *
 * Two WebSocket endpoints carry it: `/v1/runners/connect` (one socket per
 * runner, runner access token) and `/v1/app/connect` (one per app session,
 * session access token). Text messages are JSON control frames; binary
 * messages are channel data:
 *
 *   [channel u32 BE][seq u64 BE][ciphertext]   ciphertext at most 64 KiB
 *
 * A channel is one end-to-end encrypted stream between the app and a runner
 * (`control`, or `attach` to one environment). The app numbers its own
 * channels; the server gives each one a separate number on the runner's
 * socket, because two apps may talk to the same runner, and rewrites the
 * `channel` field when it forwards. `seq` and the ciphertext pass through
 * untouched, and the server cannot read the ciphertext (see e2e.ts, which
 * the server is not allowed to import).
 *
 * Flow control is credit-based, per channel and direction, counted in
 * ciphertext bytes. A sender starts with `WINDOW_BYTES` of credit and may
 * not send past it; the receiver returns credit with `window { ch, credit }`
 * as it consumes data. The server enforces the same arithmetic: a sender
 * that overruns its credit, or a receiver that returns credit it was never
 * owed, loses the channel (`flow-control`). So the server never buffers more
 * than one window per channel direction however slow a reader is.
 *
 * An app socket stays authorized only until the access token presented at
 * upgrade expires. The server closes it with 4401 `token-expired` at that
 * time, and with 4401 `signed-out` when the session is revoked. The app
 * extends the same socket, without dropping its channels, by sending
 * `{ "type": "auth", "token": "<PSA access token>" }` for that same
 * session. A token for another session, or any token the server rejects,
 * closes the socket with 4401 `token-expired`.
 */

import { createHash } from 'node:crypto';

export const PROTOCOL = 'puck-relay-v1';
export const DATA_HEADER_BYTES = 12;
export const MAX_CIPHERTEXT_BYTES = 64 * 1024;
export const WINDOW_BYTES = 256 * 1024;
/** A runner is Offline this long after its last frame (control, data, or a WebSocket ping). */
export const OFFLINE_AFTER_MS = 60_000;
/** How often a runner reports status. */
export const STATUS_EVERY_MS = 20_000;
/** A channel the runner has not accepted within this long is closed. */
export const OPEN_TIMEOUT_MS = 30_000;
/** Open channels per app socket. */
export const MAX_CHANNELS_PER_APP = 64;
export const MAX_CHANNEL_ID = 0xffffffff;

export type ChannelKind = 'control' | 'attach';

export interface DockerStatus {
  ok: boolean;
  version: string | null;
  problem: string | null;
  ncpu: number | null;
  memTotal: number | null;
}

/** What a runner reports in `hello` and every `status`. */
export interface RunnerStatus {
  version: string;
  docker: DockerStatus;
  maxEnvironments: number | null;
  instances: { envId: string; state: string }[];
}

export type RunnerToServer =
  | ({ type: 'hello' } & RunnerStatus)
  | ({ type: 'status' } & RunnerStatus)
  | { type: 'accept'; ch: number; e2e: { runnerEphemeralPub: string; sig: string } }
  | { type: 'close'; ch: number; reason: string }
  | { type: 'window'; ch: number; credit: number }
  | { type: 'ping'; t: number };

export type ServerToRunner =
  | {
      type: 'open';
      ch: number;
      /** The app's own number for the channel; the runner signs it in the handshake. */
      appCh: number;
      kind: ChannelKind;
      envId: string | null;
      userId: string;
      e2e: { appEphemeralPub: string };
    }
  | { type: 'close'; ch: number; reason: string }
  | { type: 'window'; ch: number; credit: number }
  | { type: 'pong'; t: number };

export type AppToServer =
  | { type: 'auth'; token: string }
  | { type: 'open'; ch: number; runnerId: string; kind: ChannelKind; envId?: string; e2e: { appEphemeralPub: string } }
  | { type: 'close'; ch: number; reason: string }
  | { type: 'window'; ch: number; credit: number }
  | { type: 'ping'; t: number };

export type ServerToApp =
  | { type: 'accept'; ch: number; e2e: { runnerEphemeralPub: string; sig: string } }
  | { type: 'close'; ch: number; reason: string }
  | { type: 'window'; ch: number; credit: number }
  | { type: 'pong'; t: number }
  | { type: 'event'; event: { type: string; [k: string]: unknown } };

export interface DataFrame {
  ch: number;
  seq: bigint;
  payload: Buffer;
}

export function encodeData(ch: number, seq: bigint, payload: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(DATA_HEADER_BYTES + payload.length);
  out.writeUInt32BE(ch, 0);
  out.writeBigUInt64BE(seq, 4);
  out.set(payload, DATA_HEADER_BYTES);
  return out;
}

/** The frame, or null when it is malformed or oversized. */
export function decodeData(buf: Buffer): DataFrame | null {
  if (buf.length <= DATA_HEADER_BYTES || buf.length > DATA_HEADER_BYTES + MAX_CIPHERTEXT_BYTES) return null;
  return { ch: buf.readUInt32BE(0), seq: buf.readBigUInt64BE(4), payload: buf.subarray(DATA_HEADER_BYTES) };
}

/** A copy of `frame` addressed to another channel number. */
export function readdress(frame: Buffer, ch: number): Buffer {
  const out = Buffer.from(frame);
  out.writeUInt32BE(ch, 0);
  return out;
}

export function isChannelId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_CHANNEL_ID;
}

/** A raw 32-byte Ed25519 or X25519 public key in base64url, or null. */
export function rawKey(text: unknown): Buffer | null {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(text)) return null;
  const buf = Buffer.from(text, 'base64url');
  return buf.length === 32 ? buf : null;
}

/** `SHA256:<base64>` of the raw public key, the form runners print and Settings shows. */
export function keyFingerprint(publicKey: string): string {
  const raw = rawKey(publicKey);
  if (!raw) throw new Error('not a raw 32-byte public key');
  return `SHA256:${createHash('sha256').update(raw).digest('base64').replace(/=+$/, '')}`;
}
