import { contextBridge, ipcRenderer } from 'electron';
import type { BridgeEventPayload, EnvironmentConfig, PuckBridge } from './harness/bridge';
import { CHANNELS, EVENT_CHANNEL } from './harness/channels';

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
  providerAuthLogout: (id) => ipcRenderer.invoke(CHANNELS.providerAuthLogout, id),

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

  convoSave: (agentId, data) => ipcRenderer.invoke(CHANNELS.convoSave, { agentId, data }),
  convoLoad: () => ipcRenderer.invoke(CHANNELS.convoLoad),

  startTurn: (turnId, agentId, prompt) =>
    ipcRenderer.invoke(CHANNELS.startTurn, { turnId, agentId, prompt }),
  interrupt: (turnId) => ipcRenderer.invoke(CHANNELS.interrupt, turnId),
  answerAsk: (turnId, askId, answers) =>
    ipcRenderer.invoke(CHANNELS.answerAsk, { turnId, askId, answers }),
  onEvent: (cb) => {
    ipcRenderer.on(EVENT_CHANNEL, (_event, payload: BridgeEventPayload) => cb(payload));
  },
};

contextBridge.exposeInMainWorld('puck', bridge);
