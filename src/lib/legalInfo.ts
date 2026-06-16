/**
 * Operator details for the Impressum / Datenschutz pages.
 *
 * These are injected at BUILD time from environment variables so your real
 * name / address / contact never live in the (public) git repo or its history.
 *  - Locally: put them in a gitignored `.env.local` (see `.env.example`).
 *  - On deploy: set them in Cloudflare Pages → Settings → Environment variables.
 *
 * IMPORTANT: an Impressum is legally required to be PUBLICLY VISIBLE, so these
 * values still appear on the deployed page (and in the shipped JS bundle). This
 * only keeps them out of the source repository — it does not hide them from
 * site visitors, and is not a place for true secrets.
 *
 * When the env vars are unset (e.g. a contributor's local build), obvious
 * `[PLACEHOLDER]` fallbacks render instead, and the "draft" notice stays
 * visible (see `legalInfoComplete`).
 */
const env = import.meta.env

export const legalInfo = {
  name: env.VITE_LEGAL_NAME || '[YOUR FULL NAME]',
  street: env.VITE_LEGAL_STREET || '[STREET AND HOUSE NUMBER]',
  city: env.VITE_LEGAL_CITY || '[POSTAL CODE] [CITY]',
  country: env.VITE_LEGAL_COUNTRY || 'Germany',
  email: env.VITE_LEGAL_EMAIL || '[YOUR-EMAIL]',
  /** Optional — render the phone line only when set. */
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
