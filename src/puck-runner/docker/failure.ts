/**
 * The one classification of a failed docker command. The client
 * (`client.ts`) attaches it to every result once, so the operations
 * (`ops.ts`) and the health check (`health.ts`) branch on a field and never
 * read stderr for meaning:
 *
 *   not-found    the named container, volume or image does not exist
 *   permission   this user cannot use the Docker socket
 *   daemon-down  the engine is not running, or its socket is missing
 *   cli-missing  discovery found no docker CLI (`discovery.ts`)
 *   timeout      the client's guard killed the command (`TIMEOUTS`)
 *   cancelled    the caller's signal aborted the command
 *   other        anything else; stderr carries the detail
 *
 * Only the first three come from stderr, and these rules are the only place
 * stderr is matched. Pure: the classifier test owns the patterns.
 */

export type DockerFailure = 'not-found' | 'permission' | 'daemon-down' | 'cli-missing' | 'timeout' | 'cancelled' | 'other';

/** Ordered: the first matching rule wins, so a missing socket reads as the engine, never as a missing object. */
const RULES: ReadonlyArray<{ failure: DockerFailure; re: RegExp }> = [
  { failure: 'permission', re: /permission denied while trying to connect to the docker|docker\.sock: connect: permission denied/i },
  { failure: 'daemon-down', re: /docker\.sock\S*:? (connect: )?(no such file or directory|connection refused)/i },
  { failure: 'daemon-down', re: /cannot connect to the docker daemon|is the docker daemon running/i },
  { failure: 'not-found', re: /no such (container|volume|image|object)|image not known/i },
];

/** What a failed command's stderr (or an engine error it printed) says went wrong. */
export function classifyStderr(stderr: string): DockerFailure {
  return RULES.find((rule) => rule.re.test(stderr))?.failure ?? 'other';
}
