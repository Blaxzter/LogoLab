# A/B feature stamps — local only

`pnpm gen:absnapshot [name] [--logos all|a,b|none]` freezes the tracer's current output
here, one subdir per stamp, so the next change can be judged against it in **/labs/ab →
Vs snapshot**. Each subdir holds, per case: the exact input pixels (`<id>.png`), the
serialized trace with gradients off and on (`<id>.flat.svg`, `<id>.grad.svg`), and a
`manifest.json` recording the git rev (`+dirty` when the tree had modifications) and date.

**Nothing in here is committed** (`.gitignore`), for two reasons:

- a stamp is a *working artifact*, not a source of truth — it is regenerable from any
  revision (`git stash && pnpm gen:absnapshot && git stash pop` freezes the last committed
  code), and what a change is judged against depends on what you are changing;
- the ◆ gallery lane traces real brand marks from `examples/logos/`, which are themselves
  gitignored trademarks (`npm run fetch:logos`). Their traces must not be redistributed
  either.

So a stamp lives exactly as long as you need it. Two consequences worth knowing:

- switching branches will not delete these files (git does not touch ignored paths), but
  they are yours alone — a stamp you want to keep should be copied somewhere outside the
  repo, not pushed;
- a few diagnostics read a specific stamp by name (`src/devtest/rimCapDiag.ts` and
  `rimCapRender.ts` want `before-lowres`). If it is not here, regenerate it from the
  revision the diagnostic is about, or point the script at another stamp — both say so
  when the file is missing.

The workflow and the reasoning behind the input-pixel contract are in `docs/labs.md`
("The A/B lab can compare against a frozen revision"); the case list — both lanes — is
`src/devtest/abCorpus.ts`.
