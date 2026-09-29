/**
 * The runner shell (PUCK_UI=v2): environments from the Puck server, a start
 * form (definition, runner, secrets), and the orchestrator chat. The app
 * sends daemon commands; it does not run docker. Context and elements in,
 * controller out.
 */

import type { DaemonEventPayload, InstanceInfo, PinSpec, PuckBridge, RunnersState } from '../harness/bridge';
import type { DaemonEvent, InflightTurn, Snapshot } from '../harness/daemon-protocol';
import type { EnvironmentSummary } from '../harness/definitions/types';
import { placement } from '../harness/placement';
import type { TranscriptEntry } from '../harness/transcript';
import { el } from './dom';
import { errText } from './util';

export interface V2Elements {
  list: HTMLElement;
  startForm: HTMLFormElement;
  refSelect: HTMLSelectElement;
  defSelect: HTMLSelectElement;
  runnerSelect: HTMLSelectElement;
  secrets: HTMLElement;
  startBtn: HTMLButtonElement;
  progress: HTMLElement;
  chat: HTMLElement;
  composer: HTMLFormElement;
  prompt: HTMLTextAreaElement;
  send: HTMLButtonElement;
  error: HTMLElement;
}

export interface V2Shell {
  /** The environment whose daemon events are applied. */
  openEnvId(): string | null;
}

export function initV2Shell(ctx: { bridge: PuckBridge; els: V2Elements }): V2Shell {
  const { bridge, els } = ctx;
  const instances = new Map<string, InstanceInfo>();
  let runners: RunnersState | null = null;
  let environments: EnvironmentSummary[] = [];
  let openId: string | null = null;
  let orchestratorId: string | null = null;
  let cursor: number | null = null;
  let viewGen = 0;
  let resyncing = false;
  let resyncGen = 0;
  let resyncAt: number | null = null;
  let snapshotFlight: Promise<void> | null = null;
  let snapshotTicket: object | null = null;
  const attachWaiters: { envId: string; gen: number; resolve: () => void }[] = [];
  const buffered = new Map<number, DaemonEvent>();

  function say(text: string): void {
    els.error.textContent = text;
  }

  function append(role: string, text: string): void {
    if (!text) return;
    const last = els.chat.lastElementChild;
    if (role === 'agent' && last?.classList.contains('agent')) {
      last.textContent = `${last.textContent ?? ''}${text}`;
      els.chat.scrollTop = els.chat.scrollHeight;
      return;
    }
    els.chat.appendChild(el('p', `v2-line ${role}`, text));
    els.chat.scrollTop = els.chat.scrollHeight;
  }

  function renderTranscript(entry: TranscriptEntry): void {
    if (entry.kind === 'user') append(entry.author === 'user' ? 'user' : 'note', entry.text);
    else if (entry.kind === 'turn') {
      append('agent', entry.events.flatMap((ev) => (ev.kind === 'text-delta' ? [ev.text] : [])).join(''));
    } else append('note', entry.notices.map((n) => n.text).join('\n'));
  }

  function renderInflight(turn: InflightTurn): void {
    append('agent', turn.events.flatMap((ev) => (ev.kind === 'text-delta' ? [ev.text] : [])).join(''));
  }

  function renderEvent(ev: DaemonEvent): void {
    if (ev.kind === 'turn.user' && (!orchestratorId || ev.sessionId === orchestratorId)) append('user', ev.entry.text);
    else if (ev.kind === 'turn.notice' && (!orchestratorId || ev.sessionId === orchestratorId)) {
      append('note', ev.entry.notices.map((n) => n.text).join('\n'));
    } else if (ev.kind === 'turn.event' && ev.event.kind === 'text-delta' && (!orchestratorId || ev.sessionId === orchestratorId)) {
      append('agent', ev.event.text);
    } else if (ev.kind === 'session.upsert' && ev.session.kind === 'orchestrator') orchestratorId = ev.session.id;
  }

  function drain(): void {
    if (cursor === null) return;
    while (buffered.has(cursor + 1)) {
      const seq = cursor + 1;
      const ev = buffered.get(seq);
      buffered.delete(seq);
      cursor = seq;
      if (ev) renderEvent(ev);
    }
    const gap = [...buffered.keys()].some((seq) => seq > (cursor ?? 0) + 1);
    if (gap && openId && !resyncing && resyncAt !== cursor) void resync(openId);
  }

  async function showSnapshot(envId: string, snapshot: Snapshot): Promise<void> {
    if (envId !== openId) return;
    const gen = ++viewGen;
    let entries: TranscriptEntry[] = [];
    if (snapshot.orchestratorSessionId) {
      try {
        const page = await bridge.daemon(envId, 'session.history', { sessionId: snapshot.orchestratorSessionId });
        entries = page.entries;
      } catch (err) {
        if (gen === viewGen) say(errText(err));
      }
    }
    if (gen !== viewGen || envId !== openId) return;
    cursor = snapshot.head;
    resyncAt = snapshot.head;
    orchestratorId = snapshot.orchestratorSessionId;
    for (const seq of [...buffered.keys()]) if (seq <= snapshot.head) buffered.delete(seq);
    const seen = new Set(entries.flatMap((entry) => (entry.kind === 'turn' ? [entry.turnId] : [])));
    els.chat.textContent = '';
    for (const entry of entries) renderTranscript(entry);
    for (const turn of snapshot.inflight) {
      if (seen.has(turn.turnId)) continue;
      if (orchestratorId && turn.sessionId !== orchestratorId) continue;
      renderInflight(turn);
    }
    drain();
  }

  function dropWaiters(): void {
    const pending = attachWaiters.splice(0);
    for (const waiter of pending) waiter.resolve();
  }

  function releaseAttached(envId: string): void {
    for (let i = attachWaiters.length - 1; i >= 0; i--) {
      const waiter = attachWaiters[i];
      if (waiter && waiter.envId === envId && waiter.gen === viewGen) {
        attachWaiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }

  function whenAttached(envId: string, gen: number): Promise<void> {
    if (gen !== viewGen || openId !== envId) return Promise.resolve();
    if (instances.get(envId)?.attach === 'attached') return Promise.resolve();
    return new Promise((resolve) => {
      attachWaiters.push({ envId, gen, resolve });
    });
  }

  function requestSnapshot(envId: string): Promise<void> {
    if (openId !== envId || cursor !== null) return Promise.resolve();
    if (snapshotFlight) return snapshotFlight;
    const gen = viewGen;
    const ticket = {};
    const flight = (async () => {
      try {
        await whenAttached(envId, gen);
        if (gen !== viewGen || openId !== envId || cursor !== null) return;
        if (instances.get(envId)?.attach !== 'attached') return;
        const snapshot = await bridge.daemon(envId, 'snapshot.get', {});
        if (gen !== viewGen || openId !== envId) return;
        say('');
        await showSnapshot(envId, snapshot);
      } finally {
        if (snapshotTicket === ticket) {
          snapshotFlight = null;
          snapshotTicket = null;
        }
      }
    })();
    snapshotFlight = flight;
    snapshotTicket = ticket;
    return flight;
  }

  async function resync(envId: string): Promise<void> {
    if (resyncing || envId !== openId) return;
    resyncing = true;
    resyncAt = cursor;
    const gen = viewGen;
    const mine = ++resyncGen;
    try {
      await whenAttached(envId, gen);
      if (gen !== viewGen || envId !== openId) return;
      if (instances.get(envId)?.attach !== 'attached') return;
      const snapshot = await bridge.daemon(envId, 'snapshot.get', {});
      if (gen !== viewGen || envId !== openId) return;
      await showSnapshot(envId, snapshot);
    } catch (err) {
      if (gen === viewGen && envId === openId) say(errText(err));
    } finally {
      if (mine === resyncGen) resyncing = false;
    }
  }

  function onDaemon(payload: DaemonEventPayload): void {
    if ('snapshot' in payload) {
      if (payload.envId === openId) void showSnapshot(payload.envId, payload.snapshot);
      return;
    }
    if (payload.envId !== openId) return;
    if (cursor !== null && payload.seq <= cursor) return;
    buffered.set(payload.seq, payload.ev);
    drain();
  }

  function renderList(): void {
    els.list.textContent = '';
    if (!instances.size) {
      els.list.appendChild(el('p', 'v2-empty', 'No environments yet.'));
      return;
    }
    for (const info of instances.values()) {
      const btn = el('button', `v2-env${info.id === openId ? ' selected' : ''}`) as HTMLButtonElement;
      btn.type = 'button';
      btn.dataset.env = info.id;
      btn.textContent = `${info.name} · ${info.runnerName} · ${info.op?.stage ?? info.status}`;
      btn.addEventListener('click', () => {
        const id = info.id;
        void open(id).catch((err) => {
          if (openId === id) say(errText(err));
        });
      });
      els.list.appendChild(btn);
    }
  }

  function showProgress(info: InstanceInfo): void {
    if (info.id !== openId) return;
    if (info.op?.error) els.progress.textContent = info.op.error;
    else if (info.op) els.progress.textContent = [info.op.stage, info.op.detail].filter(Boolean).join(' · ');
    else if (info.daemon) els.progress.textContent = info.daemon.detail || info.daemon.status;
    else els.progress.textContent = '';
  }

  function selectedEnvironment(): EnvironmentSummary | null {
    return environments.find((env) => env.name === els.defSelect.value) ?? null;
  }

  function renderRunners(): void {
    const prev = els.runnerSelect.value;
    const env = selectedEnvironment();
    const resources = env?.resources ?? { cpus: null, memory: null };
    els.runnerSelect.textContent = '';
    const blank = el('option', '', 'Choose a runner') as HTMLOptionElement;
    blank.value = '';
    els.runnerSelect.appendChild(blank);
    for (const runner of runners?.runners ?? []) {
      const hosted = runner.environments.filter((e) => e.status === 'active').length;
      const fit = placement(
        {
          name: runner.name,
          status: runner.status,
          docker: runner.docker,
          maxEnvironments: runner.maxEnvironments,
          keyChanged: runner.keyChanged,
        },
        hosted,
        resources,
      );
      const option = el('option', '') as HTMLOptionElement;
      option.value = runner.id;
      option.disabled = !fit.ok;
      const capacity = runner.maxEnvironments === null ? `${runner.running} running` : `${hosted}/${runner.maxEnvironments}`;
      const docker = runner.docker?.version ? `Docker ${runner.docker.version}` : 'Docker';
      option.textContent = fit.ok ? `${runner.name} · ${docker} · ${capacity}` : `${runner.name} — ${fit.reason}`;
      els.runnerSelect.appendChild(option);
    }
    const still = [...els.runnerSelect.options].some((o) => o.value === prev && !o.disabled);
    els.runnerSelect.value = still ? prev : ([...els.runnerSelect.options].find((o) => o.value && !o.disabled)?.value ?? '');
  }

  function renderSecrets(): void {
    els.secrets.textContent = '';
    const env = selectedEnvironment();
    for (const name of env?.secrets ?? []) {
      const label = el('label', 'v2-secret', name);
      const input = el('input', '') as HTMLInputElement;
      input.type = 'password';
      input.name = name;
      input.autocomplete = 'off';
      label.appendChild(input);
      els.secrets.appendChild(label);
    }
  }

  async function loadDefinitions(pin: PinSpec): Promise<void> {
    const listing = await bridge.definitionsAt(pin);
    environments = listing.environments.filter((env) => env.startable);
    const prev = els.defSelect.value;
    els.defSelect.textContent = '';
    for (const env of environments) {
      const option = el('option', '', env.name) as HTMLOptionElement;
      option.value = env.name;
      els.defSelect.appendChild(option);
    }
    if (environments.some((env) => env.name === prev)) els.defSelect.value = prev;
    renderSecrets();
    renderRunners();
  }

  function selectedPin(): PinSpec | null {
    const value = els.refSelect.value;
    const split = value.indexOf(':');
    if (split < 1) return null;
    const kind = value.slice(0, split);
    if (kind !== 'tag' && kind !== 'branch' && kind !== 'commit') return null;
    return { kind, name: value.slice(split + 1) };
  }

  async function loadRefs(): Promise<void> {
    const refs = await bridge.definitionRefs();
    els.refSelect.textContent = '';
    const add = (kind: 'tag' | 'branch', name: string): void => {
      const option = el('option', '', `${kind} ${name}`) as HTMLOptionElement;
      option.value = `${kind}:${name}`;
      els.refSelect.appendChild(option);
    };
    for (const tag of refs.tags) add('tag', tag.name);
    for (const branch of refs.branches) add('branch', branch.name);
    const preferred = refs.defaultTag ? `tag:${refs.defaultTag}` : (els.refSelect.options[0]?.value ?? '');
    if (preferred) els.refSelect.value = preferred;
    const pin = selectedPin();
    if (pin) await loadDefinitions(pin);
  }

  async function open(envId: string): Promise<void> {
    openId = envId;
    cursor = null;
    orchestratorId = null;
    resyncAt = null;
    resyncing = false;
    resyncGen++;
    buffered.clear();
    viewGen++;
    dropWaiters();
    snapshotFlight = null;
    snapshotTicket = null;
    const gen = viewGen;
    els.chat.textContent = '';
    renderList();
    const known = instances.get(envId);
    if (known) showProgress(known);
    await bridge.instanceOpen(envId);
    if (gen !== viewGen || openId !== envId) return;
    await requestSnapshot(envId);
  }

  function secretValues(): Record<string, string> {
    const values: Record<string, string> = {};
    for (const input of [...els.secrets.querySelectorAll('input')]) {
      if (input instanceof HTMLInputElement && input.name) values[input.name] = input.value;
    }
    return values;
  }

  async function start(ev: Event): Promise<void> {
    ev.preventDefault();
    say('');
    const pin = selectedPin();
    const definition = els.defSelect.value;
    const runnerId = els.runnerSelect.value;
    if (!pin || !definition || !runnerId) {
      say('Choose a definition and a runner.');
      return;
    }
    els.startBtn.disabled = true;
    try {
      const { envId } = await bridge.instanceStart({ pin, definition, runnerId, secrets: secretValues() });
      if (!instances.has(envId)) {
        instances.set(envId, {
          id: envId,
          name: definition,
          runnerId,
          runnerName: runnerName(runnerId),
          local: false,
          status: 'active',
          repos: [],
          current: true,
          attach: 'connecting',
          attachDetail: '',
          daemon: null,
          op: { kind: 'starting', stage: null, detail: 'Starting…', startedAt: Date.now(), error: null },
          lastSeq: null,
        });
      }
      renderList();
      await open(envId);
    } catch (err) {
      say(errText(err));
    } finally {
      els.startBtn.disabled = false;
    }
  }

  function runnerName(id: string): string {
    return runners?.runners.find((r) => r.id === id)?.name ?? id;
  }

  async function send(ev: Event): Promise<void> {
    ev.preventDefault();
    const text = els.prompt.value.trim();
    if (!text) return;
    if (!openId) {
      say('Open an environment first.');
      return;
    }
    say('');
    els.prompt.value = '';
    try {
      await bridge.daemon(openId, 'chat.send', orchestratorId ? { sessionId: orchestratorId, text } : { text });
    } catch (err) {
      els.prompt.value = text;
      say(errText(err));
    }
  }

  function upsert(info: InstanceInfo): void {
    instances.set(info.id, info);
    renderList();
    showProgress(info);
  }

  bridge.onInstanceEvent((event) => {
    if (event.kind === 'removed') {
      instances.delete(event.envId);
      renderList();
      return;
    }
    upsert(event.instance);
    if (event.instance.attach !== 'attached') return;
    releaseAttached(event.instance.id);
    if (event.instance.id === openId && cursor === null) {
      void requestSnapshot(event.instance.id).catch((err) => {
        if (openId === event.instance.id) say(errText(err));
      });
    }
  });
  bridge.onDaemonEvent(onDaemon);
  bridge.onRunnerEvent((event) => {
    if (event.kind === 'state') runners = event.state;
    else if (!runners) return;
    else if (event.kind === 'removed') runners = { ...runners, runners: runners.runners.filter((r) => r.id !== event.runnerId) };
    else {
      const have = runners.runners.some((r) => r.id === event.runner.id);
      runners = { ...runners, runners: have ? runners.runners.map((r) => (r.id === event.runner.id ? event.runner : r)) : [...runners.runners, event.runner] };
    }
    renderRunners();
  });

  els.startForm.addEventListener('submit', (ev) => void start(ev));
  els.composer.addEventListener('submit', (ev) => void send(ev));
  els.refSelect.addEventListener('change', () => {
    const pin = selectedPin();
    if (pin) void loadDefinitions(pin).catch((err) => say(errText(err)));
  });
  els.defSelect.addEventListener('change', () => {
    renderSecrets();
    renderRunners();
  });

  void (async () => {
    try {
      const [list, state] = await Promise.all([bridge.instanceList(), bridge.runners()]);
      for (const info of list) instances.set(info.id, info);
      runners = state;
      renderList();
      renderRunners();
      await loadRefs();
      const current = list.find((info) => info.current);
      if (current) await open(current.id);
    } catch (err) {
      say(errText(err));
    }
  })();

  return { openEnvId: () => openId };
}
