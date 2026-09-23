/** webpack resolves `raw-runner` to src/main/runner/runner.js and imports it
 *  as a raw string via the `asset/source` rule (see webpack.main.config.ts). */
declare module 'raw-runner' {
  const source: string;
  export default source;
}
