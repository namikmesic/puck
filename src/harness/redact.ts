/**
 * Credential redaction shared by every log Puck writes: the app's
 * diagnostic log, the environment daemon's log, and support bundles. Pure
 * string work, so the app and the daemon run the same rules. Callers still
 * never hand a logger a credential, a prompt, or a transcript; redaction is
 * the second line of defense, not the first.
 */

// `key: value` / `"key": "value"` / `key=value` where the key smells like a
// credential. The value is replaced, the key stays so the line remains useful.
const SECRET_KV =
  /("?)([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|authorization|credential|cookie)[A-Za-z0-9_.-]*)("?\s*[:=]\s*)((?:Bearer\s+)?(?:"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}\]]+))/gi;

const SECRET_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]'],
  // Anthropic / OpenAI style API keys (`sk-ant-...`, `sk-proj-...`, `sk-...`).
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted-jwt]'],
  // Any long opaque blob: OAuth access and refresh tokens have no fixed prefix.
  // Docker ids (64 hex) fall under this too, which is an acceptable loss.
  [/[A-Za-z0-9_+=-]{48,}/g, '[redacted-long]'],
];

/** Scrubs credential-looking material from a line of text. */
export function redact(text: string): string {
  let out = text.replace(SECRET_KV, '$1$2$3[redacted]');
  for (const [shape, replacement] of SECRET_SHAPES) out = out.replace(shape, replacement);
  return out;
}
