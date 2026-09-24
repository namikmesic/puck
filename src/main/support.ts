/**
 * Support bundle (main process).
 *
 * The diagnostic export a user attaches to a bug report: the rotating log
 * files plus a sanitized summary of the configuration, zipped to a location
 * the user picks in a save dialog. The summary carries ids, names, versions,
 * states, and key NAMES. It never carries token material, secret or env-var
 * values, system prompts, prompts, or transcripts. Default for the open
 * release call C-10: a local export, no hosted crash reporting.
 */

import { app, dialog, type BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SupportInfo } from '../harness/bridge';
import * as agents from './agents';
import { docker } from './docker-client';
import * as environments from './environments';
import { log, redact } from './log';
import { providers } from './providers';
import { zipBuffer, type ZipEntry } from './zip';

/** What the Settings → Support page shows: version and the two data paths. */
export function supportInfo(): SupportInfo {
  return { version: app.getVersion(), dataDir: app.getPath('userData'), logFile: log.file() };
}

export interface SupportSummary {
  generatedAt: string;
  app: {
    name: string;
    version: string;
    packaged: boolean;
    electron: string;
    chrome: string;
    node: string;
    platform: string;
    arch: string;
    osRelease: string;
    dataDir: string;
  };
  providers: Array<{ id: string; label: string; connected: boolean; pending: boolean }>;
  agents: Array<{
    id: string;
    name: string;
    provider: string;
    model: string;
    effort: string;
    optionKeys: string[];
    systemPromptChars: number;
    advancedSet: boolean;
    active: boolean;
  }>;
  environments: Array<{
    id: string;
    name: string;
    image: string;
    dockerfileSet: boolean;
    workspacePath: string;
    autoInstall: boolean;
    envVarKeys: string[];
    secretKeys: string[];
    /** Lifecycle status, and the current or failing stage when there is one. */
    status: string;
    stage: string | null;
    active: boolean;
  }>;
  docker: { version: string; containers: string[] };
  logs: string[];
}

/** The sanitized configuration summary. Every field is a name, an id, a flag, a count, or a version. */
export async function supportSummary(now: Date = new Date()): Promise<SupportSummary> {
  const [agentInfos, envInfos, version, containers] = await Promise.all([
    Promise.resolve(agents.list()),
    environments.list().catch(() => []),
    docker(['version', '--format', '{{.Client.Version}} client, {{.Server.Version}} server']),
    docker(['ps', '-a', '--filter', 'label=puck=environment', '--format', '{{.Names}} | {{.Status}} | {{.Image}}']),
  ]);
  const dockerError = (r: { code: number | null; stderr: string }): string =>
    `unavailable: ${r.stderr.trim() || `docker exited ${r.code}`}`;
  return {
    generatedAt: now.toISOString(),
    app: {
      name: app.getName(),
      version: app.getVersion(),
      packaged: app.isPackaged,
      electron: process.versions.electron ?? 'n/a',
      chrome: process.versions.chrome ?? 'n/a',
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      osRelease: os.release(),
      dataDir: app.getPath('userData'),
    },
    providers: providers.map((p) => {
      const auth = p.auth.status();
      return { id: p.id, label: p.label, connected: auth.connected, pending: auth.pending };
    }),
    agents: agentInfos.map((a) => ({
      id: a.id,
      name: a.name,
      provider: a.provider,
      model: a.model,
      effort: a.effort,
      optionKeys: Object.keys(a.options).sort(),
      systemPromptChars: a.systemPrompt.length,
      advancedSet: a.advanced.trim().length > 0,
      active: a.active,
    })),
    environments: envInfos.map((e) => ({
      id: e.id,
      name: e.name,
      image: e.image,
      dockerfileSet: e.dockerfile.trim().length > 0,
      workspacePath: e.workspacePath,
      autoInstall: e.autoInstall,
      envVarKeys: Object.keys(e.envVars).sort(),
      secretKeys: [...e.secretKeys].sort(),
      status: e.status,
      stage: e.stage,
      active: e.active,
    })),
    docker: {
      version: version.code === 0 ? version.stdout.trim() : dockerError(version),
      containers:
        containers.code === 0
          ? containers.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
          : [dockerError(containers)],
    },
    logs: log.files().map((f) => path.basename(f)),
  };
}

const BUNDLE_README = `Puck support bundle

summary.json  app, Electron, and Docker versions; providers (connected or not);
              agents and environments by id and name, with option and key NAMES only.
logs/         Puck's diagnostic log, newest file first (puck.log, then puck.log.1, ...).

Nothing here is a token, a secret value, an environment-variable value, a
system prompt, a prompt, or a transcript. Review the files before you share
them; they do include the data folder and workspace paths on your Mac.
`;

export interface SupportBundle {
  fileName: string;
  zip: Buffer;
  /** Archive entry names, in order. */
  entries: string[];
}

export function bundleFileName(now: Date): string {
  return `puck-support-${now.toISOString().replace(/[:.]/g, '-').slice(0, 19)}.zip`;
}

/** Builds the ZIP in memory: README, summary, then every log file. */
export async function buildSupportBundle(now: Date = new Date()): Promise<SupportBundle> {
  const summary = await supportSummary(now);
  const entries: ZipEntry[] = [
    { name: 'README.txt', data: BUNDLE_README, mtime: now },
    { name: 'summary.json', data: JSON.stringify(summary, null, 2), mtime: now },
  ];
  for (const file of log.files()) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // rotated away between listing and reading
    }
    // Lines were redacted when written; redacting again costs nothing and
    // also covers lines written before a redaction rule existed.
    entries.push({ name: `logs/${path.basename(file)}`, data: redact(text), mtime: now });
  }
  return {
    fileName: bundleFileName(now),
    zip: zipBuffer(entries, now),
    entries: entries.map((e) => e.name),
  };
}

function downloadsDir(): string {
  try {
    return app.getPath('downloads');
  } catch {
    return os.homedir();
  }
}

/**
 * Asks where to save, then builds and writes the bundle. Resolves with the
 * chosen path, or null when the user canceled (nothing is written then).
 */
export async function exportSupportBundle(owner: BrowserWindow | null): Promise<{ path: string | null }> {
  const options = {
    title: 'Save support bundle',
    defaultPath: path.join(downloadsDir(), bundleFileName(new Date())),
    filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
  };
  const picked = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
  if (picked.canceled || !picked.filePath) {
    log.info('support.export.canceled');
    return { path: null };
  }
  const bundle = await buildSupportBundle();
  await fs.promises.writeFile(picked.filePath, bundle.zip);
  log.info('support.exported', { bytes: bundle.zip.length, entries: bundle.entries.length });
  return { path: picked.filePath };
}
