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
  status: 'harness:status',
  providers: 'provider:list',
  openExternal: 'shell:open-external',
  providerAuthStart: 'provider:auth-start',
  providerAuthCancel: 'provider:auth-cancel',
  providerAuthLogout: 'provider:auth-logout',
  githubInstallations: 'github:installations',
  githubRepos: 'github:repos',
  githubSetConfigRepo: 'github:set-config-repo',

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

  agentList: 'agent:list',
  agentCreate: 'agent:create',
  agentUpdate: 'agent:update',
  agentDelete: 'agent:delete',
  agentSelect: 'agent:select',

  envList: 'env:list',
  envCreate: 'env:create',
  envUpdate: 'env:update',
  envDelete: 'env:delete',
  envStart: 'env:start',
  envStop: 'env:stop',
  envRestart: 'env:restart',
  envRebuild: 'env:rebuild',
  envSecretSet: 'env:secret-set',
  envSecretDelete: 'env:secret-delete',
  envSelect: 'env:select',

  convoSave: 'convo:save',
  convoLoad: 'convo:load',

  supportInfo: 'support:info',
  supportExport: 'support:export',

  startTurn: 'harness:start-turn',
  interrupt: 'harness:interrupt',
  answerAsk: 'harness:answer-ask',
} as const satisfies Record<
  Exclude<keyof PuckBridge, 'onEvent' | 'onFlush' | 'onEnvEvent' | 'onRunnerEvent' | 'onInstanceEvent' | 'onDaemonEvent'>,
  string
>;

/* Push channels (main → renderer) live outside the invoke table. */

/** Harness events, tagged with their turnId. */
export const EVENT_CHANNEL = 'harness:event';
/** Environment lifecycle progress (`EnvLifecycleEvent`). */
export const ENV_EVENT_CHANNEL = 'env:lifecycle';
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
