/*
 * Datenschutzerklärung (privacy policy) — Art. 13 GDPR / DSGVO.
 *
 * The actual text lives in `datenschutz.generated.html` (imported raw) so you
 * can paste the output from datenschutz-generator.de straight in, instead of
 * porting it to JSX. Personal data is NOT baked into that file — it uses
 * {{NAME}} / {{STREET}} / {{CITY}} / {{COUNTRY}} / {{EMAIL}} / {{PHONE}} tokens
 * that are filled at build time from the VITE_LEGAL_* env vars (see legalInfo.ts
 * and .env.example), so your address stays out of the public repo.
 *
 * The HTML is your own authored content, so dangerouslySetInnerHTML is safe
 * here (no user input is involved).
 */
import { LegalShell } from './LegalShell'
import { fillLegalTokens, legalInfoComplete } from '../../lib/legalInfo'
import rawHtml from './datenschutz.generated.html?raw'

/** If a full HTML document was pasted, keep only the <body> contents. */
function bodyOf(html: string): string {
  const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  return match ? match[1] : html
}

const html = fillLegalTokens(bodyOf(rawHtml))

export default function Datenschutz() {
  return (
    <LegalShell>
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {!legalInfoComplete && (
        <p className="note">
          Operator details come from the <code>VITE_LEGAL_*</code> build environment variables (see{' '}
          <code>.env.example</code>); set them in Cloudflare Pages, and have the text reviewed before
          publishing.
        </p>
      )}
    </LegalShell>
  )
}
