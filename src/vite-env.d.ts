/// <reference types="vite/client" />

// Operator details for the legal pages, injected at build time (see
// src/lib/legalInfo.ts and .env.example). Kept out of the public repo.
interface ImportMetaEnv {
  readonly VITE_LEGAL_NAME?: string
  readonly VITE_LEGAL_STREET?: string
  readonly VITE_LEGAL_CITY?: string
  readonly VITE_LEGAL_COUNTRY?: string
  readonly VITE_LEGAL_EMAIL?: string
  readonly VITE_LEGAL_PHONE?: string
}

// imagetracerjs ships no type declarations.
declare module 'imagetracerjs' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ImageTracer: any
  export default ImageTracer
}
