// Publishes the studio's live settings for the crash screen's bug report.

import { useEffect, type RefObject } from "react";
import { docStats } from "../../../lib/path/model";
import type { EditableDoc } from "../../../lib/path/types";
import { provideReportContext } from "../../../lib/report/reportContext";
import type { InkColorMode } from "../../../lib/traceInput/ink";
import type { VectorizeOptions } from "../../../types";
import type { VectorizeSource } from "./types";

export function useStudioReportContext({
    persist,
    logo,
    colorMode,
    optsRef,
    docRef,
}: {
    persist: boolean;
    logo: VectorizeSource;
    colorMode: InkColorMode;
    optsRef: RefObject<VectorizeOptions>;
    docRef: RefObject<EditableDoc | null>;
}) {
    // Published for the crash screen's bug report (lib/report/reportContext). Reads the
    // refs, not closed-over values, so the snapshot taken at crash time describes
    // the options live then. Never includes pixels, only the image's shape.
    // biome-ignore lint/correctness/useExhaustiveDependencies: the refs are the studio's, stable
    useEffect(
        () =>
            provideReportContext(persist ? "vectorize" : "sheet-tile", () => ({
                source: {
                    width: logo.naturalWidth,
                    height: logo.naturalHeight,
                    isSvg: logo.isSvg,
                },
                colorMode,
                traced: docRef.current ? docStats(docRef.current) : null,
                options: optsRef.current,
            })),
        [persist, colorMode, logo.naturalWidth, logo.naturalHeight, logo.isSvg],
    );
}
