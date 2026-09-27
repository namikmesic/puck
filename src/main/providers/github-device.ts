/**
 * One device-flow sign-in at a time: request the code, poll in the
 * background, hand the tokens to `onTokens`, and forget the flow. Starting
 * again or cancelling aborts the previous poll, whose result is dropped.
 */

import type { DeviceCodePrompt } from '../../harness/bridge';
import {
  abortError,
  defaultDeps,
  pollDeviceToken,
  requestDeviceCode,
  type GitHubDeps,
  type UserTokens,
} from '../../harness/github';

export interface DeviceSignIn {
  start(clientId: string): Promise<DeviceCodePrompt>;
  cancel(): void;
  /** The code of the sign-in in progress, or null. */
  pending(): DeviceCodePrompt | null;
}

export function createDeviceSignIn(cfg: {
  /** Completes the sign-in (fetch the user, save the tokens). Its rejection is reported to onError. */
  onTokens(tokens: UserTokens): Promise<void>;
  onError(err: unknown): void;
  /** Read per sign-in, so a test seam set later still applies. */
  deps?: () => GitHubDeps | undefined;
}): DeviceSignIn {
  let current: AbortController | null = null;
  let prompt: DeviceCodePrompt | null = null;

  function cancel(): void {
    current?.abort();
    current = null;
    prompt = null;
  }

  return {
    async start(clientId) {
      cancel();
      const deps = cfg.deps?.() ?? defaultDeps;
      const abort = new AbortController();
      current = abort;
      const code = await requestDeviceCode(clientId, deps, abort.signal);
      if (abort.signal.aborted) throw abortError();
      const mine: DeviceCodePrompt = {
        userCode: code.userCode,
        verificationUri: code.verificationUri,
        expiresAt: code.expiresAt,
      };
      prompt = mine;
      void pollDeviceToken(clientId, code, deps, abort.signal)
        .then((tokens) => (abort.signal.aborted ? undefined : cfg.onTokens(tokens)))
        .catch((err: unknown) => {
          if (!abort.signal.aborted) cfg.onError(err);
        })
        .finally(() => {
          if (current === abort) {
            current = null;
            prompt = null;
          }
        });
      return mine;
    },
    cancel,
    pending: () => prompt,
  };
}
