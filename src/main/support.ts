/**
 * Support bundle (main process).
 *
 * The diagnostic export a user attaches to a bug report: the rotating log
 * files plus a sanitized summary of the configuration, zipped to a location
 * the user picks in a save dialog. The summary carries ids, names, versions,
 * states, and key NAMES. It never carries token material, secret or env-var
 * values, prompts, or transcripts. A local export, no hosted crash
 * reporting.
 */

import { app, dialog, type BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SupportInfo } from '../harness/bridge';
import { log, redact } from './log';
import * as instances from './instances';
import { byKind } from './providers';
import * as runners from './runners';
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
  /** The Puck server connection and the user's runners (no keys, no tokens). */
  runners: {
    server: string;
    signedIn: boolean;
    connection: string;
    thisMac: { installed: boolean; runnerId: string | null };
    list: Array<{ id: string; name: string; os: string; arch: string; version: string; status: string; docker: string | null; local: boolean }>;
  };
  /** Environments on runners, by id, definition name, runner, and state. */
  instances: Array<{ id: string; name: string; runnerId: string; status: string; attach: string | null; daemon: string | null; lastSeq: number | null }>;
  logs: string[];
}

/** The sanitized configuration summary. Every field is a name, an id, a flag, a count, or a version. */
export async function supportSummary(now: Date = new Date()): Promise<SupportSummary> {
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
    providers: byKind('harness').map((p) => {
      const auth = p.auth.status();
      return { id: p.id, label: p.label, connected: auth.connected, pending: auth.pending };
    }),
    runners: (() => {
      const r = runners.state();
      return {
        server: r.server,
        signedIn: r.signedIn,
        connection: r.connection,
        thisMac: { installed: r.local.installed, runnerId: r.local.runnerId },
        list: r.runners.map((x) => ({
          id: x.id,
          name: x.name,
          os: x.os,
          arch: x.arch,
          version: x.version,
          status: x.status,
          docker: x.docker?.version ?? x.docker?.problem ?? null,
          local: x.local,
        })),
      };
    })(),
    instances: instances.list().map((i) => ({
      id: i.id,
      name: i.name,
      runnerId: i.runnerId,
      status: i.status,
      attach: i.attach,
      daemon: i.daemon?.status ?? null,
      lastSeq: i.lastSeq,
    })),
    logs: log.files().map((f) => path.basename(f)),
  };
}

const BUNDLE_README = `Puck support bundle

summary.json  app and Electron versions; harness providers (connected or not);
              the Puck server connection; runners (with their Docker version) and
              the environments on them, by id, name and state.
logs/         Puck's diagnostic log, newest file first (puck.log, then puck.log.1, ...).

Nothing here is a token, a secret value, an environment-variable value, a
prompt, or a transcript. Review the files before you share them; they do
include the data folder path on your Mac.
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
