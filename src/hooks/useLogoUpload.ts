import { useCallback, useState } from 'react'
import { useStore } from '../store'
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

  const handleFile = useCallback(
    async (file: File | undefined | null) => {
      if (!file) return
      if (!/^image\//.test(file.type) && !/\.svg$/i.test(file.name)) {
        setError('Please drop an image file (PNG, SVG, JPG, WebP…).')
        return
      }
      setError(null)
      setLoading(true)
      try {
        clearLogo()
        const patch = await loadLogoFile(file)
        setLogo(patch)
      } catch {
        setError('Could not read that file.')
      } finally {
        setLoading(false)
      }
    },
    [clearLogo, setLogo],
  )

  return { handleFile, loading, error, setError }
}
