/**
 * The macOS LaunchAgent plist and the launcher it runs. Pure text: the
 * runner's `svc install` and This Mac's keep-and-start path both write this,
 * so an older agent is rewritten to the same program and app association.
 * macOS names the background item after the launcher's file name.
 */

/** The LaunchAgent's program. macOS shows its file name as the background item's name. */
export const LAUNCHER = 'puck-runner';

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const decodeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** POSIX join. LaunchAgent paths are macOS paths; this stays free of node imports. */
function posixJoin(root: string, ...parts: string[]): string {
  return [root.replace(/\/+$/, ''), ...parts].join('/');
}

/** `root` + launcher, with a single slash. */
export function launcherPath(root: string): string {
  return posixJoin(root, LAUNCHER);
}

export function launcherScript(): string {
  return [
    '#!/bin/sh',
    '# The LaunchAgent\'s program: macOS names the background item after this file.',
    '# Written by ./svc.sh install and removed by ./svc.sh uninstall; it runs ./run.sh.',
    'DIR=$(cd "$(dirname "$0")" && pwd)',
    'exec "$DIR/run.sh" "$@"',
    '',
  ].join('\n');
}

export function launchdPlist(opts: { label: string; root: string; appBundleId?: string | null }): string {
  const log = posixJoin(opts.root, '_diag', 'service.log');
  const associated = opts.appBundleId
    ? ['  <key>AssociatedBundleIdentifiers</key>', '  <array>', `    <string>${xml(opts.appBundleId)}</string>`, '  </array>']
    : [];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xml(opts.label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xml(launcherPath(opts.root))}</string>`,
    '  </array>',
    ...associated,
    '  <key>WorkingDirectory</key>',
    `  <string>${xml(opts.root)}</string>`,
    '  <key>EnvironmentVariables</key>',
    '  <dict>',
    '    <key>PUCK_RUNNER_SERVICE</key>',
    '    <string>launchd</string>',
    '  </dict>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '  <key>ThrottleInterval</key>',
    '  <integer>10</integer>',
    '  <key>StandardOutPath</key>',
    `  <string>${xml(log)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${xml(log)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

/** The LaunchAgent program path, from its plist, or null when the plist has none. */
export function launchAgentProgram(plist: string): string | null {
  const m = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(plist);
  return m ? decodeXml(m[1]) : null;
}

/** File name macOS shows in Login Items for this plist, or null. */
export function loginItemName(plist: string): string | null {
  const program = launchAgentProgram(plist);
  if (!program) return null;
  const slash = program.lastIndexOf('/');
  return slash === -1 ? program : program.slice(slash + 1);
}

/** True when the plist associates the agent with `bundleId`. */
export function launchAgentNamesApp(plist: string, bundleId: string): boolean {
  return plist.includes('<key>AssociatedBundleIdentifiers</key>') && plist.includes(`<string>${xml(bundleId)}</string>`);
}

/** True when `launchctl bootout` failed because that label is not loaded. */
export function launchdNotLoaded(code: number | null, output: string): boolean {
  return code === 3 || /No such process|Could not find (specified )?service/i.test(output);
}

/** Program basename from `launchctl print`: the name Login Items shows for the loaded job. */
export function launchdPrintedProgram(printStdout: string): string | null {
  const program = /^\s*program = (.+)$/m.exec(printStdout)?.[1]?.trim();
  if (!program) return null;
  const slash = program.lastIndexOf('/');
  const base = (slash === -1 ? program : program.slice(slash + 1)).trim();
  return base || null;
}

/** True when `launchctl print` shows the job running. */
export function launchdPrintedRunning(printStdout: string): boolean {
  return /^\s*state = running\s*$/m.test(printStdout);
}
