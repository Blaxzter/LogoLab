/** FNV-1a over a string → 8 hex chars. The same hash bench/metrics.ts uses for `hashDoc`.
 *  Its own module (no `import.meta.glob`) so node tests can reach it. */
export function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}
