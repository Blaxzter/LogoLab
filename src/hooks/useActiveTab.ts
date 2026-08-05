import { useLocation } from 'react-router-dom'
import type { Tab } from '../store'

/** The panel tabs — each maps 1:1 to a top-level route segment. */
const TAB_SET = new Set<Tab>(['preview', 'cleanup', 'vectorize', 'sheet', 'export'])

/**
 * The active tab, derived from the URL's first path segment (the router is the
 * single source of truth for which panel is showing). Unknown / root paths fall
 * back to `preview`, matching the redirects in {@link App}.
 */
export function useActiveTab(): Tab {
  const seg = useLocation().pathname.split('/')[1]
  return TAB_SET.has(seg as Tab) ? (seg as Tab) : 'preview'
}
