/** webpack resolves these to .webpack/daemon/puckd.js (as a raw string via
 *  the `asset/source` rule) and its puckd.meta.json (see webpack.main.config.ts). */
declare module 'raw-daemon' {
  const source: string;
  export default source;
}
declare module 'raw-daemon-meta' {
  const meta: { version: string; build: string };
  export default meta;
}
