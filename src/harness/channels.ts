/**
 * The IPC channel table — single source of truth for channel names.
 *
 * `preload.ts` (invoke side) and `src/index.ts` (handle side) both import
 * this, and the `satisfies` clause makes the table total over `PuckBridge`
 * at compile time: adding a bridge method without a channel, or a channel
 * without a bridge method, is a type error. test/unit/channels.test.ts
 * additionally asserts the main process registers a handler for every entry.
 */

import type { PuckBridge } from './bridge';

export const CHANNELS = {
  providers: 'provider:list',
  openExternal: 'shell:open-external',
  providerAuthStart: 'provider:auth-start',
  providerAuthCancel: 'provider:auth-cancel',
  providerAuthLogout: 'provider:auth-logout',
  githubInstallations: 'github:installations',
  githubRepos: 'github:repos',
  githubConnectHome: 'github:connect-home',
  githubInitHome: 'github:init-home',

  runners: 'runner:list',
  runnerRegistrationToken: 'runner:registration-token',
  runnerRegistrationCancel: 'runner:registration-cancel',
  runnerRemovalToken: 'runner:removal-token',
  runnerForceRemove: 'runner:force-remove',
  runnerUpdate: 'runner:update',
  runnerInstallLocal: 'runner:install-local',
  runnerUninstallLocal: 'runner:uninstall-local',

  instanceList: 'instance:list',
  instanceStart: 'instance:start',
  instanceOpen: 'instance:open',
  instanceStop: 'instance:stop',
  instanceResume: 'instance:resume',
  instanceRebuild: 'instance:rebuild',
  instanceDelete: 'instance:delete',
  instanceForget: 'instance:forget',
  instanceCheckUpdate: 'instance:check-update',
  instanceApplyUpdate: 'instance:apply-update',
  instanceUpgradeDaemon: 'instance:upgrade-daemon',
  daemon: 'daemon:command',

  definitionRefs: 'defs:refs',
  definitionsAt: 'defs:at',

  supportInfo: 'support:info',
  supportExport: 'support:export',
} as const satisfies Record<
  Exclude<keyof PuckBridge, 'onFlush' | 'onRunnerEvent' | 'onInstanceEvent' | 'onDaemonEvent'>,
  string
>;

/* Push channels (main → renderer) live outside the invoke table. */

/** Runner list, This Mac and server-connection changes (`RunnerEvent`). */
export const RUNNER_EVENT_CHANNEL = 'runner:event';
/** Environment changes (`InstanceEvent`). */
export const INSTANCE_EVENT_CHANNEL = 'instance:event';
/** The attached environment's daemon events (`DaemonEventPayload`). */
export const DAEMON_EVENT_CHANNEL = 'daemon:event';
/** Main is about to quit: persist everything pending (payload: a token). */
export const FLUSH_CHANNEL = 'app:flush';
/** The renderer's one-way reply once its saves settled (payload: that token). */
export const FLUSHED_CHANNEL = 'app:flushed';
