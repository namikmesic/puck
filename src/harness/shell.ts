/** One literal POSIX shell argument. Control characters cannot enter copied scripts. */
export function shellQuote(value: string): string {
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  })) {
    throw new Error('Runner installation values must not contain control characters.');
  }
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
