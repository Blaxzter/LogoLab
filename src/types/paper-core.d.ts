// paper ships types for its full build only; the core build (no PaperScript
// parser, ~30 KB lighter) is the same API.
declare module 'paper/dist/paper-core.js' {
  import paper from 'paper'
  export default paper
}
