import { contextBridge, ipcRenderer } from 'electron';
import type {
  BridgeEventPayload,
  DaemonEventPayload,
  EnvironmentConfig,
  EnvLifecycleEvent,
  InstanceEvent,
  PuckBridge,
  RunnerEvent,
} from './harness/bridge';
import {
  CHANNELS,
  DAEMON_EVENT_CHANNEL,
  ENV_EVENT_CHANNEL,
  EVENT_CHANNEL,
  FLUSH_CHANNEL,
  FLUSHED_CHANNEL,
  INSTANCE_EVENT_CHANNEL,
  RUNNER_EVENT_CHANNEL,
} from './harness/channels';

const bridge: PuckBridge = {
  status: () => ipcRenderer.invoke(CHANNELS.status),
  providers: () => ipcRenderer.invoke(CHANNELS.providers),
  openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url),
  agentList: () => ipcRenderer.invoke(CHANNELS.agentList),
  agentCreate: (cfg) => ipcRenderer.invoke(CHANNELS.agentCreate, cfg),
  agentUpdate: (id, cfg) => ipcRenderer.invoke(CHANNELS.agentUpdate, { id, cfg }),
  agentDelete: (id) => ipcRenderer.invoke(CHANNELS.agentDelete, id),
  agentSelect: (id) => ipcRenderer.invoke(CHANNELS.agentSelect, id),
  providerAuthStart: (id) => ipcRenderer.invoke(CHANNELS.providerAuthStart, id),
  providerAuthCancel: (id) => ipcRenderer.invoke(CHANNELS.providerAuthCancel, id),
  providerAuthLogout: (id) => ipcRenderer.invoke(CHANNELS.providerAuthLogout, id),
  runners: () => ipcRenderer.invoke(CHANNELS.runners),
  runnerRegistrationToken: () => ipcRenderer.invoke(CHANNELS.runnerRegistrationToken),
  runnerRegistrationCancel: (tokenId) => ipcRenderer.invoke(CHANNELS.runnerRegistrationCancel, tokenId),
  runnerRemovalToken: (runnerId) => ipcRenderer.invoke(CHANNELS.runnerRemovalToken, runnerId),
  runnerForceRemove: (runnerId) => ipcRenderer.invoke(CHANNELS.runnerForceRemove, runnerId),
  runnerUpdate: (runnerId, patch) => ipcRenderer.invoke(CHANNELS.runnerUpdate, { runnerId, patch }),
  runnerInstallLocal: () => ipcRenderer.invoke(CHANNELS.runnerInstallLocal),
  runnerUninstallLocal: () => ipcRenderer.invoke(CHANNELS.runnerUninstallLocal),
  onRunnerEvent: (cb) => {
    ipcRenderer.on(RUNNER_EVENT_CHANNEL, (_event, payload: RunnerEvent) => cb(payload));
  },
  instanceList: () => ipcRenderer.invoke(CHANNELS.instanceList),
  instanceStart: (spec) => ipcRenderer.invoke(CHANNELS.instanceStart, spec),
  instanceOpen: (envId) => ipcRenderer.invoke(CHANNELS.instanceOpen, envId),
  instanceStop: (envId) => ipcRenderer.invoke(CHANNELS.instanceStop, envId),
  instanceResume: (envId) => ipcRenderer.invoke(CHANNELS.instanceResume, envId),
  instanceRebuild: (envId) => ipcRenderer.invoke(CHANNELS.instanceRebuild, envId),
  instanceDelete: (envId) => ipcRenderer.invoke(CHANNELS.instanceDelete, envId),
  instanceForget: (envId) => ipcRenderer.invoke(CHANNELS.instanceForget, envId),
  instanceCheckUpdate: (envId) => ipcRenderer.invoke(CHANNELS.instanceCheckUpdate, envId),
  instanceApplyUpdate: (envId, pin) => ipcRenderer.invoke(CHANNELS.instanceApplyUpdate, { envId, pin }),
  onInstanceEvent: (cb) => {
    ipcRenderer.on(INSTANCE_EVENT_CHANNEL, (_event, payload: InstanceEvent) => cb(payload));
  },
  daemon: (envId, op, args) => ipcRenderer.invoke(CHANNELS.daemon, { envId, op, args }),
  onDaemonEvent: (cb) => {
    ipcRenderer.on(DAEMON_EVENT_CHANNEL, (_event, payload: DaemonEventPayload) => cb(payload));
  },
  githubInstallations: () => ipcRenderer.invoke(CHANNELS.githubInstallations),
  githubRepos: () => ipcRenderer.invoke(CHANNELS.githubRepos),
  githubSetConfigRepo: (fullName) => ipcRenderer.invoke(CHANNELS.githubSetConfigRepo, fullName),
  definitionRefs: () => ipcRenderer.invoke(CHANNELS.definitionRefs),
  definitionsAt: (pin) => ipcRenderer.invoke(CHANNELS.definitionsAt, pin),

  envList: () => ipcRenderer.invoke(CHANNELS.envList),
  envCreate: (cfg: EnvironmentConfig) => ipcRenderer.invoke(CHANNELS.envCreate, cfg),
  envUpdate: (id, cfg) => ipcRenderer.invoke(CHANNELS.envUpdate, { id, cfg }),
  envDelete: (id) => ipcRenderer.invoke(CHANNELS.envDelete, id),
  envStart: (id) => ipcRenderer.invoke(CHANNELS.envStart, id),
  envStop: (id) => ipcRenderer.invoke(CHANNELS.envStop, id),
  envRestart: (id) => ipcRenderer.invoke(CHANNELS.envRestart, id),
  envRebuild: (id) => ipcRenderer.invoke(CHANNELS.envRebuild, id),
  envSecretSet: (id, key, value) => ipcRenderer.invoke(CHANNELS.envSecretSet, { id, key, value }),
  envSecretDelete: (id, key) => ipcRenderer.invoke(CHANNELS.envSecretDelete, { id, key }),
  envSelect: (id) => ipcRenderer.invoke(CHANNELS.envSelect, id),
  onEnvEvent: (cb) => {
    ipcRenderer.on(ENV_EVENT_CHANNEL, (_event, payload: EnvLifecycleEvent) => cb(payload));
  },

  convoSave: (agentId, data) => ipcRenderer.invoke(CHANNELS.convoSave, { agentId, data }),
  convoLoad: () => ipcRenderer.invoke(CHANNELS.convoLoad),

  supportInfo: () => ipcRenderer.invoke(CHANNELS.supportInfo),
  supportExport: () => ipcRenderer.invoke(CHANNELS.supportExport),

  startTurn: (turnId, agentId, prompt) =>
    ipcRenderer.invoke(CHANNELS.startTurn, { turnId, agentId, prompt }),
  interrupt: (turnId) => ipcRenderer.invoke(CHANNELS.interrupt, turnId),
  answerAsk: (turnId, askId, answers) =>
    ipcRenderer.invoke(CHANNELS.answerAsk, { turnId, askId, answers }),
  onEvent: (cb) => {
    ipcRenderer.on(EVENT_CHANNEL, (_event, payload: BridgeEventPayload) => cb(payload));
  },
  onFlush: (cb) => {
    ipcRenderer.on(FLUSH_CHANNEL, (_event, token: string) => {
      // Acknowledge even when a save failed - quit must not wait on a broken save.
      void cb()
        .catch(() => undefined)
        .then(() => ipcRenderer.send(FLUSHED_CHANNEL, token));
    });
  },
};

contextBridge.exposeInMainWorld('puck', bridge);
