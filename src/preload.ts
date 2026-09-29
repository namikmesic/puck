import { contextBridge, ipcRenderer } from 'electron';
import type { DaemonEventPayload, InstanceEvent, PuckBridge, RunnerEvent } from './harness/bridge';
import {
  CHANNELS,
  DAEMON_EVENT_CHANNEL,
  FLUSH_CHANNEL,
  FLUSHED_CHANNEL,
  INSTANCE_EVENT_CHANNEL,
  RUNNER_EVENT_CHANNEL,
} from './harness/channels';

const bridge: PuckBridge = {
  providers: () => ipcRenderer.invoke(CHANNELS.providers),
  openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url),
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
  instanceUpgradeDaemon: (envId, mode) => ipcRenderer.invoke(CHANNELS.instanceUpgradeDaemon, { envId, mode }),
  onInstanceEvent: (cb) => {
    ipcRenderer.on(INSTANCE_EVENT_CHANNEL, (_event, payload: InstanceEvent) => cb(payload));
  },
  daemon: (envId, op, args) => ipcRenderer.invoke(CHANNELS.daemon, { envId, op, args }),
  onDaemonEvent: (cb) => {
    ipcRenderer.on(DAEMON_EVENT_CHANNEL, (_event, payload: DaemonEventPayload) => cb(payload));
  },
  githubInstallations: () => ipcRenderer.invoke(CHANNELS.githubInstallations),
  githubRepos: () => ipcRenderer.invoke(CHANNELS.githubRepos),
  githubConnectHome: (fullName) => ipcRenderer.invoke(CHANNELS.githubConnectHome, fullName),
  githubInitHome: (home, envRepo) => ipcRenderer.invoke(CHANNELS.githubInitHome, { home, envRepo }),
  definitionRefs: () => ipcRenderer.invoke(CHANNELS.definitionRefs),
  definitionsAt: (pin) => ipcRenderer.invoke(CHANNELS.definitionsAt, pin),

  supportInfo: () => ipcRenderer.invoke(CHANNELS.supportInfo),
  supportExport: () => ipcRenderer.invoke(CHANNELS.supportExport),

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
