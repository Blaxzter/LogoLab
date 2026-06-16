/*
 * Impressum (legal notice) — required under § 5 DDG for German operators.
 *
 * ⚠️ BEFORE DEPLOY: replace every [PLACEHOLDER] with your real details. A
 * ladungsfähige Anschrift (a real postal address where legal mail can be
 * served — no P.O. box) is mandatory. Have the final text sanity-checked by
 * a generator (e.g. eRecht24, datenschutz-generator.de) or a lawyer.
 */
import { LegalShell } from './LegalShell'
import { legalInfo, legalInfoComplete } from '../../lib/legalInfo'

export default function Impressum() {
  return (
    <LegalShell>
      <h1>Impressum</h1>
      <p className="lead">Legal notice in accordance with § 5 DDG (Digitale-Dienste-Gesetz).</p>

      <h2>Angaben gemäß § 5 DDG</h2>
      <address>
        {legalInfo.name}
        <br />
        {legalInfo.street}
        <br />
        {legalInfo.city}
        <br />
        {legalInfo.country}
      </address>

      <h2>Kontakt / Contact</h2>
      <p>
        Email: <a href={`mailto:${legalInfo.email}`}>{legalInfo.email}</a>
        {legalInfo.phone && (
          <>
            <br />
            Phone: {legalInfo.phone}
          </>
        )}
      </p>

      <h2>Verantwortlich für den Inhalt / Responsible for content</h2>
      <p>{legalInfo.name}, address as above.</p>

      <h2>Consumer dispute resolution</h2>
      <p>
        The EU Commission provides a platform for online dispute resolution (ODR):{' '}
        <a href="https://ec.europa.eu/consumers/odr" target="_blank" rel="noreferrer">
          https://ec.europa.eu/consumers/odr
        </a>
        . We are neither obligated nor willing to participate in dispute resolution
        proceedings before a consumer arbitration board (§ 36 VSBG).
      </p>

      <hr />

      <h2>Liability for content</h2>
      <p>
        As a service provider we are responsible for our own content on these pages under the
        general laws (§ 7 (1) DDG). Under §§ 8 to 10 DDG, however, we are not obligated to monitor
        transmitted or stored third-party information, or to investigate circumstances that indicate
        illegal activity. Obligations to remove or block the use of information under the general
        laws remain unaffected. Liability in this regard is only possible from the point in time at
        which a concrete infringement of the law becomes known. Upon notification of such
        violations, we will remove the content immediately.
      </p>

      <h2>Liability for links</h2>
      <p>
        Our offer contains links to external third-party websites over whose content we have no
        influence. Therefore we cannot assume any liability for this external content. The
        respective provider or operator of the linked pages is always responsible for their content.
        The linked pages were checked for possible legal violations at the time of linking; no
        illegal content was discernible at that time. Should we become aware of any infringements,
        we will remove such links immediately.
      </p>

      <h2>Copyright</h2>
      <p>
        The content created by the operator on these pages is subject to German copyright law.
        LogoLab itself is open-source software, released under the MIT License; see the{' '}
        <a href="https://github.com/Blaxzter/LogoLab" target="_blank" rel="noreferrer">
          GitHub repository
        </a>{' '}
        for the licence terms. Images and logos that <strong>you</strong> load into the app remain
        your property and are processed only in your browser.
      </p>

      {!legalInfoComplete && (
        <p className="note">
          Draft template — operator details come from the <code>VITE_LEGAL_*</code> build
          environment variables (see <code>.env.example</code>); set them in Cloudflare Pages
          before publishing, and have the text reviewed.
        </p>
      )}
    </LegalShell>
  )
}
