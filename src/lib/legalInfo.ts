/**
 * Operator details for the Impressum / Datenschutz pages, injected at build
 * time from environment variables so they stay out of the git repo.
 *  - Locally: a gitignored `.env.local` (see `.env.example`).
 *  - On deploy: Cloudflare → Workers & Pages → logo-lab → Settings → Build → Variables.
 *
 * An Impressum must be publicly visible, so these values still ship in the
 * page and the JS bundle; this is not a place for secrets.
 *
 * When unset, `[PLACEHOLDER]` fallbacks render and the draft notice stays
 * visible (see `legalInfoComplete`).
 */
const env = import.meta.env

export const legalInfo = {
  name: env.VITE_LEGAL_NAME || '[YOUR FULL NAME]',
  street: env.VITE_LEGAL_STREET || '[STREET AND HOUSE NUMBER]',
  city: env.VITE_LEGAL_CITY || '[POSTAL CODE] [CITY]',
  country: env.VITE_LEGAL_COUNTRY || 'Germany',
  email: env.VITE_LEGAL_EMAIL || '[YOUR-EMAIL]',
  /** Optional; the phone line renders only when set. */
  phone: env.VITE_LEGAL_PHONE || '',
}

/** True once the essential details are provided — used to hide the draft notice. */
export const legalInfoComplete = Boolean(
  env.VITE_LEGAL_NAME && env.VITE_LEGAL_STREET && env.VITE_LEGAL_CITY && env.VITE_LEGAL_EMAIL,
)

/**
 * Fill `{{TOKEN}}` placeholders in a raw HTML string (e.g. the committed
 * Datenschutz HTML) with the env-injected operator details, so the personal
 * data never lives in the committed file. Unknown tokens are left untouched.
 *
 * Supported tokens: {{NAME}} {{STREET}} {{CITY}} {{COUNTRY}} {{EMAIL}} {{PHONE}}
 */
export function fillLegalTokens(html: string): string {
  const tokens: Record<string, string> = {
    NAME: legalInfo.name,
    STREET: legalInfo.street,
    CITY: legalInfo.city,
    COUNTRY: legalInfo.country,
    EMAIL: legalInfo.email,
    PHONE: legalInfo.phone,
  }
  return html.replace(/\{\{(\w+)\}\}/g, (match, key) => tokens[key] ?? match)
}
