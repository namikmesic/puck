/**
 * Codex's host half: the pure descriptor (src/harness/providers/codex.ts)
 * plus sign-in, the CLI credential file mirrored into containers, and the
 * model picker extension.
 */

import { codexHarness } from '../../harness/providers';
import type { HarnessProvider } from './types';
import { providerAuth, providerCredential, signInStatus } from './oauth';
import * as oauth from './codex-oauth';

export const codexProvider: HarnessProvider = {
  ...codexHarness,
  kind: 'harness',
  // Extend the picker with PUCK_CODEX_MODELS=a,b,c
  models: [
    ...codexHarness.models,
    ...(process.env.PUCK_CODEX_MODELS?.split(',').map((m) => m.trim()).filter(Boolean) ?? []),
  ],

  auth: providerAuth(oauth.account, {
    start: oauth.startLogin,
    cancel: oauth.cancelLogin,
    pending: oauth.loginPending,
    signInHint: 'Not connected — sign in with your ChatGPT account',
    connectedDetail: (tokens) => `Connected — last refreshed ${tokens.lastRefresh.slice(0, 16)}`,
  }),

  status() {
    return signInStatus(oauth.account, this.auth.status());
  },

  credential: providerCredential(oauth.account, {
    containerPath: '/root/.codex/auth.json',
    serialize: oauth.authJsonContent,
  }),
};
