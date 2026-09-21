# LogoLab — working notes for agents

Drop in a logo → preview in context → **vectorize** to clean SVG → export PWA icons. The
vectorizer (raster → planar shared-edge trace) is the heart of the app: `src/lib/trace/`. It
is also the npm package **`logolab`** — the same tracer as an MCP server — so read *The tracer
ships TWICE* below before you call a change to it done.

## Before ANY vectorizer change: freeze an A/B snapshot

A change to the tracer (`src/lib/trace/**`, segmentation, beautify, fit) can silently move the
output on cases you weren't looking at. So **before** you start, freeze a baseline:

```
pnpm gen:absnapshot before-<what>     # e.g. before-checker
```

Then make the change and open **`/labs/ab`** → pick your baseline in the **Baseline**
dropdown → **Changed only** shows exactly which cases moved, and each gets a **diff heat**
panel showing *where*. This is how you catch collateral changes (a corner-veto for `checker`
also nudged `aa-seam`'s flat trace — only the A/B view revealed it).

If you also freeze an `after-<what>` stamp when the change is accepted, the two are a **pair**:
they show up in the Baseline dropdown under **⇄ Pairs** as one entry that diffs the two FROZEN
stamps against each other (nothing traced, so it does not decay as you keep working, and the
`after-` stamp is not dead weight). **Compare with** is the same control by hand — working tree
(the default) or any other snapshot. Don't stamp an `after-` unless you mean to keep it: a lone
`before-` is the normal case, and the pair is for a result worth being able to re-open later.

Every case is traced in **three lanes** (`AB_LANES`), each at the resolution production uses
for that art: flat at the flat cap, gradient/photo at the gradient cap, and **mono** — which
is NOT a subset of the colour path (`mode: 'mono'` returns before segmentation and the colour
lanes pin `engine: 'planar'`, which routes around the two modules mono is made of). The mono
cut comes from the ink probe on the raster, not a constant, so the lane traces what a user
actually gets. Old stamps keep working: every lane's resolution is recorded per stamp.

Two case lanes, both in `src/devtest/abCorpus.ts`: the ⟐ **fixtures** (handcrafted, one mechanism
each — good gates, weak evidence: they are "good enough" long before real art is) and a slice
of the ◆ **gallery** corpus, the same brand marks `/labs/gallery` shows, rasterized on white
exactly as that page does. The gallery lane needs `npm run fetch:logos`; without it the lane
is empty and everything else still works. `--logos all|a,b|none` overrides the slice for one
run. Judge a tracer change on BOTH — the defects get reported on the marks.

Snapshots live in `test/ab-snapshots/<name>/`, several coexist, and they are **gitignored**:
a stamp is a local working artifact (regenerable from any revision), and the gallery lane
traces trademarked art that is not redistributed. Re-bless (`pnpm gen:absnapshot <name>`)
once a change is accepted.

## Verifying tracer correctness (not just "did it change")

`/labs/ab` tells you output *changed*; the **truth gate** tells you if it's *wrong*. It scores
the trace against the AUTHORED SVG (geometry, not a blessed baseline), so an improvement just
moves further inside the limits — nothing needs re-blessing.

```
node --test test/truth-gate.test.ts
```

Gates: boundary chamfer/p95, node parsimony, region recovery, **corner recovery** (a
distance-blind topology check — catches a shape rounded while every px stays sub-tolerance,
e.g. a checker cell melted to a blob), and **paint fidelity** (gradient tier 0 only: the
trace is RENDERED and scored in ΔE against the source raster — catches a paint-only failure
like a re-centred glow, which every geometry gate is blind to on gradient art, §10.3).
Open defects + the method are tracked in ONE place:
**`docs/vectorization-benchmarks.md` §0**, with `KNOWN_DEFECTS` in the test as the
machine-checked status. A case not in `KNOWN_DEFECTS` must pass every applicable gate.

## The scorer is in the PRODUCT now, and the number and the picture are one field

The studio's status bar carries a **ΔE** readout and there is a fifth view mode,
**Difference**, painting per-pixel ΔE on the same cold→hot ramp `/labs/ab` diffs two
traces with. That has two consequences for anything you touch here:

* **`fidelity()` is shipped code.** It lives in `src/lib/render/fidelity.ts`;
  `src/devtest/metrics.ts` re-exports it (like `src/devtest/raster.ts` shims the
  rasterizer). "1.8 ΔE" in the status bar and "1.8 ΔE" in the benchmark table have to be
  the same claim, so do NOT give the app its own copy of the ΔE math — take
  `deltaEField` / `deltaEStats`, which is the half `fidelity()` itself is built on.
  `src/lib/heat.ts` is the ramp, moved out of `components/labs/` for the same reason.
* **One `deltaEField` call answers both questions**, in one worker message
  (`src/lib/render/fidelity.worker.ts`). Compute the heat separately and the bar and the
  picture can describe the same trace differently — which is the one failure mode a
  screenshot cannot show you.

Three things the score gets right that are easy to undo:

* **It measures against the source WITH ITS ALPHA**, composited over white inside the
  metric. Decode the source onto white instead and art on transparency scores as a
  catastrophically wrong trace (the truth gate and the labs' fixture lane differ on
  exactly this point — see `docs/vectorization-benchmarks.md`).
* **It scores `derivedDoc`** — force-colour and all — because that is the document every
  other number in that bar describes.
* **It scores at 1024px via `rasterizeDoc`'s `scale`**, not at trace resolution. The
  compositor is O(w·h) PER PATH, so a 4096 high-detail trace would be seconds of work for
  a three-digit number; halving the resolution moves the mean by ~0.005 ΔE. `scale` also
  divides the Bézier flattening tolerance, so the chord error stays sub-pixel in OUTPUT
  space — without that a cleaned SVG (viewBox 24 units) renders as a visible polygon and
  the score blames the tracer for the renderer. `test/fidelity.test.ts` is the gate.

## The tracer ships TWICE, and only one of them is automatic

A tracer change reaches the website by itself — Cloudflare Workers Builds is connected to this
repo and deploys `main`. It does **not** reach anyone running `npx -y logolab`. That is the
same tracer, published to npm as **`logolab`** from `packages/mcp`, and it only moves when
someone cuts a release. **A tracer change is not shipped until you release one.**

`packages/mcp` has no sources of its own: it points tsc at `src/mcp/server.ts` and compiles
whatever that reaches (`src/mcp` plus `src/lib/{trace,path,sheet,render}` — 57 files today), so
your change is already *in* the package the moment you edit the tracer. It is just unpublished.

To release: bump the version in **`packages/mcp/package.json`** — the only place it lives; the
server reads it (`packageVersion` in `src/mcp/runtime.ts`) rather than repeating it — then

```
pnpm test
git tag v0.1.1 && git push origin v0.1.1     # tags are signed; make it LOCALLY
```

then Releases → Draft a new release → pick the existing tag → Publish. `release.yml` does the
rest (trusted publishing over OIDC, no npm token, provenance attached) and refuses a tag whose
version disagrees with the manifest. Do not let the GitHub UI create the tag for you: one made
server-side is unsigned, and the workflow verifies the signature.

### `test/mcp-package.test.ts` is what stops you shipping a broken package

The package's dependency list is decided by IMPORTS, in files nobody edits with npm in mind.
Add `import { x } from 'some-package'` anywhere in the tracer's graph and the app still works,
the checkout still works, the typecheck still passes — and `npx -y logolab` dies at runtime
with `ERR_MODULE_NOT_FOUND`, because that package was a devDependency of the app and was never
declared by the package that ships. The test walks the real graph (static, dynamic, and the
lazy `createRequire` that loads the optional sharp decoder) and fails on anything undeclared,
on a dependency version that drifts between the two manifests, and on the server's version
being hard-coded again instead of read. **If it fails, fix the manifests — never the
assertion.**

## The session is persisted, so studio state has TWO homes now

Every studio's state used to be session-only. It isn't: a reload restores the upload, the
appearance, the trace options and markers, the traced document (hand edits included), an
un-applied cleanup cutout, the whole icon sheet with its traces, and the editor's drawing.
`src/lib/persist/` owns it, and the split is by WHEN a value is needed, not by size:

* **localStorage** for anything that must be right in the FIRST painted frame — the stores and
  the studios seed their initial state from it synchronously. Async would mean rendering the
  defaults and then snapping to the user's settings.
* **IndexedDB** for bytes and documents. Read ONCE in `main.tsx`, before the first render, into
  a module-level payload that panels `claim()` on mount — so a lazily-mounted studio never
  races an async read against its own auto-trace.

The header's **Saved chip** (`src/components/SavedChip.tsx`) is the standing indicator, over
`src/lib/persist/status.ts`. It must be able to say **Not saved**: private mode, a blocked
origin and a full quota all make persistence impossible, and a chip that keeps reading "Saved"
through that is worse than no chip. `test/save-status.test.ts` is the gate — both of its
failure modes (reporting saved while a newer value is still in memory, or sticking on
"saving") look identical to the working version in a screenshot.

Two things to keep in mind when touching a studio:

* Anything derived from the working PIXELS is stored with `assetKey` (`src/store.ts`), which is
  reissued whenever those pixels change. Check it before adopting a restored value, or a trace
  ends up shown over a different image than it was cut from.
* A restored studio must not re-run the probes that set its defaults. `VectorizeStudio` keeps
  the ink probe (it feeds the “why” line) but runs it MEASURE-ONLY on a restore — otherwise
  the rampiness probe and the ink offer overwrite the user's own settings, which reads as
  “my options reset themselves”. “Restore” is keyed to the IMAGE (`probedAssetKey` in the
  stored view, `src/components/vectorize/probeLedger.ts`), not to a flag armed at mount: a
  stored view exists after the first ever visit, and a “Clean SVG” source never probes, so a
  mount-time flag survived an upload and handed the next image the previous image's options
  (one-ink sheet music traced colour + gradients at 1024 while the panel said “One ink →
  Mono”). `test/probe-ledger.test.ts` is the gate.

## The Editor tab IS the working logo — on CHANGE, never on open

`EditorPanel` pushes its document into the app's logo by itself (debounced); there is no
"Use as logo" button any more. The guard that matters is `doc !== opened`: the studio fires
`onChange` once with the document it was seeded with, and treating that as an edit is
destructive rather than merely redundant — round-tripping an SVG through `parseSvg` →
`serializeDoc` yields different markup for the same drawing, so *visiting* the tab would
reissue the working image, bump `assetKey`, and drop the trace and cleanup keyed to it.

It is also what makes opening an example or a dropped SVG harmless: your logo is untouched
until you actually change something. Don't replace that check with a text comparison against
`logo.svgText` — that is the weaker guard already sitting underneath it, and it does not hold
across a parse round-trip.

The open drawing lives in a MODULE-level slot as well as React state. This panel is a lazy
route, so every tab click unmounts it, and the stored session can't stand in: the boot payload
is claim-once and the first mount already took it. Without the slot, clicking to Preview and
back dropped the drawing and showed the intake screen.

## A crash costs you ONE panel, and the report is the point

There is an `ErrorBoundary` per route (`src/components/ErrorBoundary.tsx`, wired in `App.tsx`,
plus a last-resort one at the root in `main.tsx`). Three traps, all of which look like working
code:

* **`resetKey={pathname}` is load-bearing.** The router renders whichever route matched into
  the SAME position, so React reuses one boundary instance across every tab and only updates
  its props. Drop the key and a crash in Preview follows you to Cleanup — a working panel
  hidden behind a stale apology.
* **The boundary goes OUTSIDE the `<Suspense>`**, or a chunk that fails to load rejects past
  it to the root. That failure is reported differently on purpose (`isChunkLoadError`):
  `React.lazy` caches the rejection, so "Reset this panel" can never fix it and the screen
  offers a reload instead.
* **The context is collected in `getDerivedStateFromError`** — the render phase, while the
  crashing subtree is still mounted. `src/lib/reportContext.ts` is a registry that studios
  publish a snapshot function into (`VectorizeStudio` publishes its live options through the
  refs); by the time the fallback is COMMITTED those children are unmounted and every provider
  they registered has unregistered itself, so a later read is silently empty.

## Filing an issue is a FEATURE, and the crash screen is its rarest entry point

`src/lib/issueReport.ts` fills in a GitHub issue FORM — `.github/ISSUE_TEMPLATE/*.yml` — and
`src/components/ReportIssue.tsx` hangs it off four kinds: a **crash** (the boundary), a
**failure** (any catch that turns an error into a message for the user: the vectorize status
bar, the uploader, the sheet's failed tiles), a **problem** ("it traced and the result is
wrong" — the most valuable report this project gets, and it needs no failure at all) and an
**idea**, which goes to the feature form instead.

A FORM, not a `body`. GitHub prefills a form field from a query parameter keyed by that
field's `id`, so the machine half lands in its own Diagnostics box — `render: text`, so the
app sends PLAIN text, not markdown — and the human boxes stay empty with their own
placeholders. `test/issue-template.test.ts` is the gate that keeps the ids in the YAML and the
ids in `FIELDS` from drifting: GitHub ignores a parameter matching no field, so a rename
silently delivers an empty Diagnostics box on every report from then on.

Splitting one body into several fields made `title` and the summary a FIXED head the budget
cannot trim, so both are capped — otherwise a kilobyte-long error message pushes the link past
the 414 limit with nothing left to cut.

The header's bug button opens `components/ReportDialog`, not GitHub: which kind of thing is
this, what to write, and a disclosure showing exactly what gets attached. Jumping straight to
a stranger's issue tracker filed every idea as a bug and lost the people who bounced off the
form. A crash screen and a failed trace keep their DIRECT links — they already know they are
bugs and already hold the error. The labs popover moved to a FLASK so the bug glyph could mean
reporting; two bug icons in one header would have meant neither of them said anything.

The failure lane matters more than the crash lane. The tracer runs in a WORKER that catches its
own errors, so its normal bad day is a red line in a status bar, not a throw — for a long time
that line was the end of the road for a bug report.

A failure also ASKS, rather than leaving a link and hoping: `src/lib/failureNotice.ts` raises a
question into the existing bottom toast stack ("Could not vectorize this image. Report it?").
A toast and not a modal — the user is mid-task and the app still works, so a dialog they have
to dismiss before trying another setting would punish them for a failure that was not theirs.
Two rules keep it from becoming noise, and both are gated by `test/failure-notice.test.ts`:
a newer failure REPLACES the current question instead of stacking, and a DISMISSED failure
never asks again this session (the answer was no; re-asking after every retry is how people
learn to click a prompt away without reading it). A superseded question — a new trace started —
clears WITHOUT being remembered as a no, because nobody answered it. The inline Report link
stays either way.

Three traps here too:

* **A link's href is built during RENDER, and some of these links never re-render.** The mobile
  menu is a drawer that is translated off-screen rather than unmounted, so its href was built
  on the app's first render — before any studio had published anything — and filed reports with
  the settings missing. `freshHrefProps` rebuilds it on `pointerdown`/`focus`, both of which
  beat navigation (and make "copy link address" correct too).
* **`redact()` is not cosmetic.** An error message likes to quote the URL it failed on, and in
  this app that URL is sometimes a `data:` URL holding the user's actual logo. Without it, a
  decode failure would carry the user's art into a public issue tracker. A report carries the
  SHAPE of the art and never the art.
* **The log collapses repeats** (`src/lib/errorLog.ts`, in memory, never persisted). A retrying
  worker can produce one error fifty times and push everything that matters out of a 25-entry
  buffer.

The report is pure and gated by `test/issue-report.test.ts` + `test/error-log.test.ts`. It has a
URL budget — GitHub answers a request line past ~8 kB with a 414 — and it spends that budget
from the END, so the sections are ordered most-useful-first and it is the STACK that gets cut,
never the options. The options are the half nobody can reconstruct from prose.

## Tooltips FLIP, and the header's go below

`src/components/ui/Tooltip.tsx` is the app's replacement for the native `title` attribute —
there are no `title` attributes left in the rendered DOM, and adding one back is a regression,
not a shortcut. Two things about it are easy to get wrong:

* **Placement flips, it does not clamp.** The maths is pure and lives in
  `ui/tooltipPlace.ts` (its own `.ts`, because node strips types from `.ts` and NOT `.tsx`, so
  anything a test must reach has to be out of the component). Clamping BOTH axes into the
  viewport is what put a header tooltip on top of the icon it described: a control 12px from
  the top has no room above, so the default `top` side computed a negative y and the clamp
  pulled the bubble back down onto its own trigger. It flips along the main axis now and
  clamps only across it. `test/tooltip-place.test.ts` is the gate.
* **Every header tooltip passes `side="bottom"`** anyway, so the placement is the intent
  rather than a fallback being relied on. The two popover triggers pass an EMPTY label while
  open (Tooltip then renders its child alone), so a bubble can't hover over the card it just
  opened.

While you are in there: `cursor: pointer` is a base rule on every enabled `button` /
`[role=button]`, not a per-component class. It used to live only in `.btn`, which the header's
bespoke icon buttons don't use — so the anchors in that row got a pointer from the browser and
the buttons beside them didn't.

## Offline: the precache list is computed, not globbed

The app is a PWA. The service worker is hand-written (`src/pwa/sw.js`) and its precache list is
computed at build time from the chunk graph (`scripts/swPlugin.ts`): reachable from the entry,
stopping at `src/components/labs/`, `src/devtest/` and the three optional heavyweight packages.
A glob would precache all 31 MB — 27 MB of which is the research harness and the AI runtime that
a user cropping a logo never opens.

The walk follows imports AND **bare URL references in chunk code**, because that is how Vite
emits a Web Worker — and the tracer runs in one. Dropping it makes “works offline” silently mean
“works offline until you try to trace something”. `test/offline-precache.test.ts` is the gate.

### The shell must never be cached as a REDIRECTED response

A navigation may only be answered with a response that was not redirected. Hand `respondWith`
a redirected one and the browser does not fall back to the network — it fails the navigation,
and every route on the origin becomes Chrome's **“This site can't be reached / ERR_FAILED”**
for as long as the worker is installed.

The shell walks straight into it. `SHELL` is `/index.html`, and **Cloudflare Workers Assets
answers `/index.html` with a 307 to `/`** — it normalises the pretty URL. `cache.add` follows
that redirect and stores a perfectly good 200 under the `/index.html` key with `redirected`
set, so the navigate branch then serves an illegal response to every navigation. That shipped,
and it took the whole site down while looking like a server problem: the origin answers 200 to
curl on every URL, the build log is clean, and the bug is invisible to anything that is not a
browser. So `install` fetches and `put`s a rebuilt copy (`unredirected()`), and the navigate
branch ALSO refuses a redirected hit — that half is recovery, not prevention, for shells
already on disk from an older worker. `test/pwa-shell-redirect.test.ts` is the gate; it drives
the real `sw.js` against a fetch that redirects the way production does.

Neither `vite dev` nor `vite preview` redirects `/index.html`, so this reproduces **only**
against the deployed host — which is why a local check is not evidence here.

### “A new version is ready” must end in a reload

The update policy is PROMPT (`src/pwa/register.ts`), so the notice's button is the ONLY way a
waiting build ever takes over. It cannot reload the page itself — that races the handover and
lands back on the old build — so it asks the worker to skip waiting and reloads on
`controllerchange`. Everything that can go wrong there looks the same from the outside: a
button that does nothing. `src/pwa/handover.ts` owns the three rules, and
`test/pwa-handover.test.ts` is the gate:

* A first claim is **not** a reload — the first worker of all claims the page seconds after a
  first visit, and bouncing every new visitor is not an update.
* A handover **is** one, however long ago the page was claimed. The guard that shipped read a
  flag captured at BOOT, when a first-time visitor has no controller yet — so for the rest of
  that tab's life every handover was mistaken for a first install and the reload was skipped.
* One the **user asked for** always is, even if the handover never lands: `take()` arms a
  grace timer, because a dead button is worse than a reload onto the same build.

## Node

Node ≥ 22; TS is run directly via `node --experimental-strip-types`. `pnpm test` = full suite.
