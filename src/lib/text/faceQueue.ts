// The order text edits land in when some of them wait for a font.
//
// Layout is synchronous but loading a face is not, so an edit whose face isn't
// loaded is deferred until it is. Deferred on its own, each edit would land in
// whatever order its load finished: keystrokes typed while a face loads came
// out reversed ("ab" → "ba"), and a slow font picked before a fast one won. So
// once anything waits, every later edit queues behind it — immediate ones too —
// and each re-reads what it needs when its turn comes.
//
// A face that still isn't there after its load (offline, a 404, an uploaded font
// gone from storage) aborts the edit: laid out without it, the text would lose
// those glyphs' outlines, and that empty layout would be committed. The rest of
// the queue is dropped with it, since it was computed against a text that will
// now never exist.

export interface FaceNeed {
  font: string
  italic: boolean
}

export interface FaceQueue {
  /**
   * Run `step` now if nothing is queued and `needs()` is loaded, else queue it.
   * `needs` is re-read when the step's turn comes. Returns true if deferred.
   */
  run: (needs: () => FaceNeed[], step: () => void, onMissing: (needs: FaceNeed[]) => void) => boolean
  /** Whether anything is queued or running. */
  busy: () => boolean
}

export function createFaceQueue({
  ready,
  load,
  onIdle,
}: {
  ready: (need: FaceNeed) => boolean
  load: (needs: FaceNeed[]) => Promise<unknown>
  /** The queue drained (after the last deferred step ran or was dropped). */
  onIdle?: () => void
}): FaceQueue {
  let tail: Promise<void> | null = null
  let queued = 0
  // Bumped by a failure: every step queued before it is dropped.
  let generation = 0
  const allReady = (needs: FaceNeed[]) => needs.every(ready)

  return {
    busy: () => tail !== null,
    run(needs, step, onMissing) {
      if (!tail && allReady(needs())) {
        step()
        return false
      }
      const mine = generation
      queued++
      const turn = async () => {
        if (mine !== generation) return
        let n = needs()
        if (!allReady(n)) {
          await load(n)
          n = needs()
        }
        if (!allReady(n)) {
          generation++
          onMissing(n.filter((f) => !ready(f)))
          return
        }
        step()
      }
      const done = () => {
        if (--queued > 0) return
        tail = null
        onIdle?.()
      }
      tail = (tail ?? Promise.resolve()).then(turn).then(done, (err: unknown) => {
        generation++
        done()
        console.error(err)
      })
      return true
    },
  }
}
