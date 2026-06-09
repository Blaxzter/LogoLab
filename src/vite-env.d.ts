/// <reference types="vite/client" />

// imagetracerjs ships no type declarations.
declare module 'imagetracerjs' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ImageTracer: any
  export default ImageTracer
}
