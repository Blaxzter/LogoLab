// The app prefills GitHub's issue forms by field id — so the ids have to match.
//
//   node --test test/issue-template.test.ts
//
// This gate exists because the failure is SILENT at both ends. GitHub fills a
// form field from a query parameter whose key is that field's `id`, and ignores
// a parameter matching no field: rename `diagnostics` in the YAML, or fix a
// typo in the label and accidentally the id, and every report from then on
// arrives with an empty Diagnostics box. No error, no 404 — just the settings
// quietly missing from every bug report, which is the one thing the whole
// feature exists to carry.
//
// It parses the forms with regexes rather than a YAML library on purpose: the
// app has no YAML dependency, and adding one to the shipped tree to read two
// files that only GitHub ever executes would be a worse trade than a strict
// reading of `id:` lines.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { FIELDS, TEMPLATE, issueReportUrl } from '../src/lib/report/issueReport.ts'

const DIR = '.github/ISSUE_TEMPLATE'

function form(file: string): string {
  return readFileSync(`${DIR}/${file}`, 'utf8')
}

/** Every `id:` in a form's body — the keys GitHub will accept as prefills. */
function fieldIds(text: string): string[] {
  return [...text.matchAll(/^\s+id:\s*([A-Za-z0-9_-]+)\s*$/gm)].map((m) => m[1])
}

test('every template the code names exists on disk', () => {
  const present = readdirSync(DIR)
  for (const file of new Set(Object.values(TEMPLATE))) {
    assert.ok(present.includes(file), `${file} is referenced by the app but not in ${DIR}`)
  }
})

test('every field the app prefills exists in its form', () => {
  for (const [file, fields] of Object.entries(FIELDS)) {
    const ids = fieldIds(form(file))
    for (const id of Object.values(fields)) {
      assert.ok(
        ids.includes(id),
        `${file} has no field id "${id}" — every report will arrive with that box empty. Ids present: ${ids.join(', ')}`,
      )
    }
  }
})

test('field ids are unique within a form', () => {
  // GitHub rejects a form with duplicate ids, and a repo whose issue form is
  // rejected shows no template at all.
  for (const file of Object.keys(FIELDS)) {
    const ids = fieldIds(form(file))
    assert.equal(new Set(ids).size, ids.length, `${file} repeats a field id`)
  }
})

test('the diagnostics field renders as plain text, because that is what we send', () => {
  // `render: text` puts the value in a code block. Without it GitHub would
  // parse the block as markdown and the JSON braces and the stack's leading
  // spaces would come out as a mangled paragraph.
  for (const [file, fields] of Object.entries(FIELDS)) {
    const text = form(file)
    const block = text.slice(text.indexOf(`id: ${fields.diagnostics}`))
    assert.match(block.slice(0, 600), /render:\s*text/, `${file}'s ${fields.diagnostics} field is not render: text`)
  }
})

test('each form declares the label its issues should carry', () => {
  assert.match(form('bug_report.yml'), /^labels:\s*\["bug"\]/m)
  assert.match(form('feature_request.yml'), /^labels:\s*\["enhancement"\]/m)
})

test('the forms have the keys GitHub requires of every template', () => {
  for (const file of Object.keys(FIELDS)) {
    const text = form(file)
    assert.match(text, /^name:\s*\S/m, `${file} has no name:`)
    assert.match(text, /^description:\s*\S/m, `${file} has no description:`)
    assert.match(text, /^body:/m, `${file} has no body:`)
  }
})

test('a built URL names a template that exists and keys that form has', () => {
  // The end-to-end version of the two tests above: whatever the builder emits
  // has to be answerable by the YAML actually sitting in the repo.
  for (const kind of ['crash', 'failure', 'problem', 'idea'] as const) {
    const url = new URL(
      issueReportUrl({
        repoUrl: 'https://github.com/Blaxzter/LogoLab',
        what: 'the vectorizer',
        kind,
        error: new Error('boom'),
        context: { vectorize: { options: { engine: 'planar' } } },
        build: { version: '0.1.1', date: '', commit: '' },
      }),
    )
    const template = url.searchParams.get('template')
    assert.ok(template, `${kind} produced no template parameter`)
    const ids = fieldIds(form(template!))
    for (const key of url.searchParams.keys()) {
      if (key === 'template' || key === 'title') continue
      assert.ok(ids.includes(key), `${kind} sends "${key}", which ${template} has no field for`)
    }
  }
})
