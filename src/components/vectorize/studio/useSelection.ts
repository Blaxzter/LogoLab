// Path / node selection, plus the click seed a "remove & heal" delete needs.

import { useCallback, useRef, useState } from "react";
import type { Vec } from "../../../lib/path/types";

export function useSelection() {
    const [selectedPathId, setSelectedPathId] = useState<string | null>(null);
    const [selectedNodes, setSelectedNodes] = useState<ReadonlySet<string>>(
        () => new Set(),
    );

    // Mirror of selectedPathId so selection callbacks stay referentially stable.
    const selectedPathRef = useRef<string | null>(null);
    // Last in-region click that selected a path: the seed for a "remove & heal"
    // delete (which blob of a multi-blob colour to dissolve). Tied to an item id so
    // a stale seed from a previously-selected path is ignored.
    const seedRef = useRef<{ id: string; pt: Vec } | null>(null);

    const handleSelectPath = useCallback((id: string | null) => {
        if (selectedPathRef.current !== id) setSelectedNodes(new Set());
        selectedPathRef.current = id;
        setSelectedPathId(id);
    }, []);

    const handleSelectNodes = useCallback(
        (keys: Set<string>) => setSelectedNodes(keys),
        [],
    );

    const handleRegionSeed = useCallback((id: string, pt: Vec) => {
        seedRef.current = { id, pt };
    }, []);

    return {
        selectedPathId,
        selectedNodes,
        setSelectedNodes,
        selectedPathRef,
        seedRef,
        handleSelectPath,
        handleSelectNodes,
        handleRegionSeed,
    };
}
