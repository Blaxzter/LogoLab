import { useCallback, useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { logError } from '../lib/errorLog'
import { clearFailure, raiseFailure } from '../lib/failureNotice'
import { provideReportContext } from '../lib/reportContext'
import { loadLogoFile } from '../lib/image'

/**
 * Shared logo-intake logic: validate a dropped/picked File, decode it and push
 * it into the store. Used by both the sidebar UploadDropzone and the big
 * center drop zones the panels show when no logo is loaded — so the accepted
 * formats and error messages stay in one place.
 */
export function useLogoUpload() {
  const setLogo = useStore((s) => s.setLogo)
  const clearLogo = useStore((s) => s.clearLogo)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The decode error itself, so "Could not read that file" can be reported. */
  const [failure, setFailure] = useState<unknown>(null)
  /**
   * What was rejected — WITHOUT the file's name.
   *
   * A failed upload loads nothing, so the app's usual "what it was working on"
   * is empty exactly when a report needs it most: which format a browser
   * wouldn't decode is the whole question. The name is left out on the same
   * principle as the pixels — "a 512 kB image/avif" is the diagnosis, and
   * "rebrand-final-CONFIDENTIAL.avif" is the user's business.
   */
  const rejected = useRef<{ type: string | null; extension: string | null; bytes: number } | null>(
    null,
  )

  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return
      if (!/^image\//.test(file.type) && !/\.svg$/i.test(file.name)) {
        setError('Please drop an image file (PNG, SVG, JPG, WebP…).')
        return
      }
      setError(null)
      setFailure(null)
      clearFailure()
      setLoading(true)
      try {
        clearLogo()
        const patch = await loadLogoFile(file)
        setLogo(patch)
      } catch (err) {
        // A format this browser cannot decode is the likeliest cause, and which
        // format that was is exactly what the message cannot say.
        logError('upload', err)
        rejected.current = {
          type: file.type || null,
          extension: /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? null,
          bytes: file.size,
        }
        setError('Could not read that file.')
        setFailure(err)
        raiseFailure('the uploader', 'Could not read that file.', err)
      } finally {
        setLoading(false)
      }
    },
    [clearLogo, setLogo],
  )

  // Published only while a failure is on screen: the report is about THAT file,
  // and a stale entry describing last week's rejected upload would be a lie.
  useEffect(() => {
    if (!failure) return
    return provideReportContext('upload', () => rejected.current)
  }, [failure])

  return { handleFile, loading, error, setError, failure }
}
