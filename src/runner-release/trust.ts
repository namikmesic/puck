/**
 * The runner-release trust roots: the Ed25519 public keys (SPKI PEM) whose
 * signatures on a runner-release.json production servers, the app and
 * runners accept (verify.ts). They are compiled in. Nothing at run time
 * adds to them: no configuration, no environment variable, no server, and
 * no packaged-app bypass.
 *
 * An empty list means no trusted publisher, never "skip verification":
 * every signed release is refused. Adding the first key is a maintainer
 * change of its own, and only builds made after it trust that key. An
 * installed app or runner keeps the roots it was built with. Tests hand
 * their throwaway keys to the verifier directly; they never belong here,
 * and neither does any private key.
 */

export const RELEASE_KEYS: readonly string[] = Object.freeze([]);

/** Most keys a build trusts at once: an active key, a recovery key, and a rotation's overlap. */
export const MAX_RELEASE_KEYS = 4;
