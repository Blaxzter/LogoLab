// Apply / Download / Copy for the traced SVG, and the badges they leave behind.

import { useEffect, useState } from "react";
import { downloadText } from "../../../lib/export/download";
import type { EditableDoc } from "../../../lib/path/types";

export function useExportActions({
    svgText,
    derivedDoc,
    fileName,
    apply,
    setError,
    setFailure,
}: {
    svgText: string | null;
    derivedDoc: EditableDoc | null;
    fileName: string | null;
    /** Where Apply sends the SVG. */
    apply: (svgText: string, width: number, height: number) => void;
    setError: (message: string | null) => void;
    setFailure: (failure: unknown) => void;
}) {
    const [copied, setCopied] = useState(false);
    const [applied, setApplied] = useState(false);

    // Reset the "Applied" badge whenever the output changes.
    useEffect(() => {
        setApplied(false);
    }, [svgText]);

    const onDownload = () => {
        if (!svgText) return;
        const base =
            (fileName?.replace(/\.[^.]+$/, "") || "logo").trim() || "logo";
        downloadText(svgText, `${base}.svg`, "image/svg+xml");
    };

    const onApply = () => {
        if (!svgText || !derivedDoc) return;
        const [, , w, h] = derivedDoc.viewBox;
        apply(svgText, w, h);
        setApplied(true);
    };

    const onCopy = async () => {
        if (!svgText) return;
        try {
            await navigator.clipboard.writeText(svgText);
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
        } catch {
            setError("Clipboard copy was blocked by the browser.");
            setFailure(null);
        }
    };

    return { copied, applied, onDownload, onApply, onCopy };
}
