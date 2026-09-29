/** `?raw` imports: webpack's `asset/source` rule (webpack.rules.ts) and Vite both resolve them to the file's text. */
declare module '*?raw' {
  const text: string;
  export default text;
}
