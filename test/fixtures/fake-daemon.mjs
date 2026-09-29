// Stands in for `docker exec -i puck-<envId> node /opt/puck/puckd.js attach`
// in the app's relay and local-socket tests: one attach connection to a
// daemon whose event log lives in FAKE_DAEMON_LOG (so it survives
// reattaching). It speaks just enough of the daemon protocol: hello and
// welcome (resync without a cursor, else a replay of later events),
// snapshot.get, chat.send (the "orchestrator" answers "echo: <text>"),
// credentials.get/put, and ping.
import * as fs from 'node:fs';

const logFile = process.env.FAKE_DAEMON_LOG;
const envId = process.env.FAKE_DAEMON_ENV ?? 'env_01J8Z3X0000000000000000000';
const nap = new Int32Array(new SharedArrayBuffer(4));
function waitForFile(file) {
  const deadline = Date.now() + 15_000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) return;
    Atomics.wait(nap, 0, 0, 20);
  }
}
const read = () => {
  try {
    return JSON.parse(fs.readFileSync(logFile, 'utf8'));
  } catch {
    return { events: [], credentials: [] };
  }
};
// Written through a rename, so a concurrent reader never sees a half-written log.
const save = (s) => {
  fs.writeFileSync(`${logFile}.${process.pid}.tmp`, JSON.stringify(s));
  fs.renameSync(`${logFile}.${process.pid}.tmp`, logFile);
};
const out = (frame) => process.stdout.write(JSON.stringify(frame) + '\n');

let helloed = false;
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));

/** Appends events to the log, saves it, then streams them: like the real daemon, persisted before sent. */
function emit(state, ...evs) {
  const frames = evs.map((ev) => {
    const frame = { t: 'event', seq: state.events.length + 1, at: Date.now(), ev };
    state.events.push(frame);
    return frame;
  });
  save(state);
  for (const f of frames) out(f);
}

function handle(f) {
  const state = read();
  if (f.t === 'hello') {
    helloed = true;
    const head = state.events.length;
    const replay = f.since === null ? 'resync' : 'events';
    out({ t: 'welcome', protocol: 1, daemon: { version: 'fake', build: 'fake' }, envId, head, replay });
    if (replay === 'events') for (const e of state.events) if (e.seq > f.since) out(e);
    if (!state.events.length) emit(state, { kind: 'instance.status', status: 'ready' });
    return;
  }
  if (!helloed) return out({ t: 'error', code: 'bad-frame', message: 'hello first' });
  if (f.t === 'ping') return out({ t: 'pong', at: f.at });
  if (f.t !== 'cmd') return;
  const ok = (result) => out({ t: 'res', id: f.id, ok: true, result });
  switch (f.op) {
    case 'snapshot.get':
      return ok({
        envId,
        name: 'example',
        head: state.events.length,
        instance: { status: 'ready', pin: null, sha: null },
        sessions: [],
        items: [],
        order: [],
        repos: Array.isArray(state.repos) ? state.repos : [],
      });
    case 'chat.send': {
      const sessionId = 'ses_orchestrator';
      const turnId = `t${state.events.length}`;
      ok({ queued: false, turnId });
      return emit(
        state,
        { kind: 'turn.user', sessionId, entry: { kind: 'user', text: f.args.text, author: 'user', ts: 1 } },
        { kind: 'turn.start', sessionId, turnId },
        { kind: 'turn.event', sessionId, turnId, event: { kind: 'text-delta', text: `echo: ${f.args.text}` } },
        { kind: 'turn.end', sessionId, turnId, stats: {} },
      );
    }
    case 'credentials.get':
      return ok({ harness: state.credentials });
    case 'credentials.put': {
      const removing = f.args.harness.some((h) => h.content === null);
      if (removing && process.env.FAKE_DAEMON_HOLD_NULL_PUT) {
        fs.writeFileSync(`${process.env.FAKE_DAEMON_HOLD_NULL_PUT}.waiting`, '');
        waitForFile(`${process.env.FAKE_DAEMON_HOLD_NULL_PUT}.go`);
      }
      if (removing && process.env.FAKE_DAEMON_FAIL_NULL_PUT) {
        return out({ t: 'res', id: f.id, ok: false, error: { code: 'unavailable', message: 'refused' } });
      }
      for (const h of f.args.harness) {
        state.credentials = state.credentials.filter((c) => c.id !== h.id);
        if (h.content !== null) state.credentials.push(h);
      }
      save(state);
      return ok({});
    }
    default:
      return out({ t: 'res', id: f.id, ok: false, error: { code: 'invalid-args', message: `fake daemon: ${f.op}` } });
  }
}
