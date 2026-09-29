/**
 * Claude Code's host half: the pure descriptor (src/harness/providers/claude.ts)
 * plus sign-in and the CLI credential file mirrored into containers.
 */

import { claudeHarness } from '../../harness/providers';
import type { HarnessProvider } from './types';
import { providerAuth, providerCredential, signInStatus } from './oauth';
import * as oauth from './claude-oauth';

export const claudeProvider: HarnessProvider = {
  ...claudeHarness,
  kind: 'harness',

  auth: providerAuth(oauth.account, {
    start: oauth.startLogin,
    cancel: oauth.cancelLogin,
    pending: oauth.loginPending,
    signInHint: 'Not connected — sign in with your Claude account',
    connectedDetail: (tokens) =>
      `Connected — token refreshes automatically (expires ${new Date(tokens.expiresAt).toLocaleString()})`,
  }),

  status() {
    return signInStatus(oauth.account, this.auth.status());
  },

  credential: providerCredential(oauth.account, {
    serialize: oauth.credentialsFileContent,
  }),
};
