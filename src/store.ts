import { create } from "zustand";
import type { Appearance, Environment, LogoAsset } from "./types";
import { debounce, readLocal, writeLocal } from "./lib/persist/local";
import {
    newAssetKey,
    saveSlot,
    SLOTS,
    srcToBlob,
    type RestoredSession,
    type StoredLogo,
    type StoredMockShots,
} from "./lib/persist/session";

export type Tab =
    | "preview"
    | "cleanup"
    | "vectorize"
    | "editor"
    | "sheet"
    | "export";

export type DeviceId = "ios" | "android";

/** Placement of the logo icon overlaid onto a real device screenshot. */
export interface MockPlacement {
    /** Custom screenshot (object URL); null uses the bundled default. */
    shot: string | null;
    /** Icon center as a fraction of the screenshot box (0–1). */
    x: number;
    y: number;
    /** Icon width as a fraction of the screenshot width (0–1). */
    size: number;
}

/** Pristine logo fields snapshotted at upload, so Reset can fully restore them. */
type OriginalMeta = Pick<
    LogoAsset,
    "mime" | "isSvg" | "svgText" | "naturalWidth" | "naturalHeight" | "fileName"
>;

interface AppState {
    logo: LogoAsset;
    /** Snapshot of the original asset metadata (set on upload, used by Reset). */
    originalMeta: OriginalMeta | null;
    /**
     * Identity of the working image, reissued whenever its pixels change
     * (upload, cleanup Apply, trace Apply, Reset). Anything derived from the
     * image is persisted with this key; check it before adopting a restored
     * value, or a trace ends up shown over a different image than it was cut
     * from.
     */
    assetKey: string;
    appearance: Appearance;
    env: Environment;

    /** Transparency checkerboard shared by every preview; `true` = dark. */
    checkerDark: boolean;
    /** True once the user flipped it by hand, so auto-detect stops overriding. */
    checkerUserSet: boolean;
    /** User flip — sets the backdrop and pins it for the rest of the session. */
    toggleChecker: () => void;
    /** Auto-detected preference (a white mark wants the dark checker); ignored after a user flip. */
    autoChecker: (dark: boolean) => void;

    /**
     * Adopt the restored session (lib/persist/session.ts). Called once from
     * main.tsx before the first render, so a restored logo is in the first frame.
     */
    hydrate: (session: RestoredSession) => void;

    setLogo: (logo: Partial<LogoAsset> & { isLight?: boolean }) => void;
    clearLogo: () => void;
    /** Replace the working image (e.g. after background removal) with a PNG data URL. */
    setProcessedLogo: (dataUrl: string, width: number, height: number) => void;
    /** Replace the working image with a traced SVG. */
    setProcessedSvg: (svgText: string, width: number, height: number) => void;
    /** Restore the working image back to the pristine upload. */
    restoreOriginal: () => void;
    setAppearance: (patch: Partial<Appearance>) => void;
    setEnv: (patch: Partial<Environment>) => void;
    resetAppearance: () => void;

    mockups: Record<DeviceId, MockPlacement>;
    setMock: (id: DeviceId, patch: Partial<MockPlacement>) => void;
    resetMock: (id: DeviceId) => void;
}

/* ------------------------------------------------------------- persistence */

const LS_APPEARANCE = "appearance";
const LS_ENV = "env";
const LS_CHECKER = "checker";
const LS_MOCKUPS = "mockups";

export const emptyLogo: LogoAsset = {
    src: null,
    originalSrc: null,
    fileName: null,
    mime: null,
    naturalWidth: 0,
    naturalHeight: 0,
    isSvg: false,
    svgText: null,
};

export const defaultAppearance: Appearance = {
    scale: 0.85,
    padding: 10,
    cardColor: "#ffffff",
    cardShape: "rounded",
    cardRadius: 24,
    cardShadow: true,
    cardInFlat: false,
    tintEnabled: false,
    tintColor: "#5b5bd6",
    invert: false,
};

/**
 * Whether every appearance value equals its default (hides the sidebar's
 * Reset). Iterates the default's keys so stale keys in an older stored record
 * are ignored. Colours are normalized to lowercase hex upstream, so a plain
 * `===` is enough.
 */
export const isDefaultAppearance = (a: Appearance): boolean =>
    (Object.keys(defaultAppearance) as (keyof Appearance)[]).every(
        (k) => a[k] === defaultAppearance[k],
    );

export const defaultEnv: Environment = {
    theme: "light",
    pageBg: "#ffffff",
    brandName: "Acme",
};

export const defaultMockups: Record<DeviceId, MockPlacement> = {
    // Tuned to the bundled screenshots (over the first app slot); user-draggable.
    ios: { shot: null, x: 0.384, y: 0.575, size: 0.16 },
    android: { shot: null, x: 0.855, y: 0.55, size: 0.17 },
};

/**
 * Rebuild the working logo from the restored bytes. The object URLs live as
 * long as the tab, like the ones an upload creates.
 */
function restoreLogo(stored: StoredLogo | null): Pick<
    AppState,
    "logo" | "originalMeta" | "assetKey"
> {
    if (!stored) return { logo: emptyLogo, originalMeta: null, assetKey: newAssetKey() };
    try {
        const originalSrc = URL.createObjectURL(stored.original);
        const src = stored.working
            ? URL.createObjectURL(stored.working)
            : originalSrc;
        const meta = stored.workingMeta ?? stored.originalMeta;
        return {
            logo: {
                src,
                originalSrc,
                fileName: stored.fileName,
                mime: meta.mime,
                isSvg: meta.isSvg,
                svgText: meta.svgText,
                naturalWidth: meta.naturalWidth,
                naturalHeight: meta.naturalHeight,
            },
            originalMeta: { ...stored.originalMeta, fileName: stored.fileName },
            // Same pixels the stored trace was cut from, so keep the key.
            assetKey: stored.assetKey,
        };
    } catch {
        return { logo: emptyLogo, originalMeta: null, assetKey: newAssetKey() };
    }
}

/** Icon placements, synchronously from localStorage; custom screenshots come from IndexedDB in `hydrate`. */
function storedPlacements(): Record<DeviceId, MockPlacement> {
    const placements = readLocal(LS_MOCKUPS, defaultMockups);
    return {
        ios: { ...defaultMockups.ios, ...placements.ios, shot: null },
        android: { ...defaultMockups.android, ...placements.android, shot: null },
    };
}

/** Custom device screenshots, back as object URLs over the stored bytes. */
function withShots(
    mockups: Record<DeviceId, MockPlacement>,
    stored: StoredMockShots | null,
): Record<DeviceId, MockPlacement> {
    // Return the same object when there is nothing to apply, so subscribers
    // aren't woken and nothing is written back.
    if (!stored?.ios && !stored?.android) return mockups
    const shot = (blob: Blob | null | undefined): string | null => {
        try {
            return blob ? URL.createObjectURL(blob) : null;
        } catch {
            return null;
        }
    };
    return {
        ios: { ...mockups.ios, shot: shot(stored?.ios) },
        android: { ...mockups.android, shot: shot(stored?.android) },
    };
}

export const useStore = create<AppState>((set) => ({
    logo: emptyLogo,
    originalMeta: null,
    assetKey: newAssetKey(),
    appearance: readLocal(LS_APPEARANCE, defaultAppearance),
    env: readLocal(LS_ENV, defaultEnv),
    ...readLocal(LS_CHECKER, { checkerDark: false, checkerUserSet: false }),

    hydrate: (session) =>
        set((s) => {
            const logo = restoreLogo(session.logo);
            const mockups = withShots(s.mockups, session.mockShots);
            // Seed the stored signatures so the subscription below doesn't
            // write the just-restored bytes straight back.
            storedLogoSig = logo.logo.originalSrc
                ? `${logo.assetKey}|${logo.logo.originalSrc}|${logo.logo.src ?? ""}`
                : "";
            storedShotSig = `${mockups.ios.shot ?? ""}|${mockups.android.shot ?? ""}`;
            return { ...logo, mockups };
        }),

    toggleChecker: () =>
        set((s) => ({ checkerDark: !s.checkerDark, checkerUserSet: true })),

    autoChecker: (dark) =>
        set((s) => (s.checkerUserSet ? {} : { checkerDark: dark })),

    setLogo: ({ isLight, ...patch }) =>
        set((s) => {
            const logo = { ...s.logo, ...patch };
            // A fresh upload carries originalSrc — snapshot its metadata for Reset.
            const originalMeta = patch.originalSrc
                ? {
                      mime: logo.mime,
                      isSvg: logo.isSvg,
                      svgText: logo.svgText,
                      naturalWidth: logo.naturalWidth,
                      naturalHeight: logo.naturalHeight,
                      fileName: logo.fileName,
                  }
                : s.originalMeta;
            // On a fresh upload, pick the checker that keeps the mark visible,
            // unless the user already chose one.
            const autoChecker =
                patch.originalSrc && !s.checkerUserSet && isLight !== undefined
                    ? { checkerDark: isLight }
                    : null;
            // Only a fresh upload is a new image; a metadata-only patch keeps the key.
            const assetKey = patch.originalSrc ? newAssetKey() : s.assetKey;
            return { logo, originalMeta, assetKey, ...autoChecker };
        }),
    clearLogo: () =>
        set((s) => {
            if (s.logo.src && s.logo.src.startsWith("blob:"))
                URL.revokeObjectURL(s.logo.src);
            if (
                s.logo.originalSrc &&
                s.logo.originalSrc !== s.logo.src &&
                s.logo.originalSrc.startsWith("blob:")
            ) {
                URL.revokeObjectURL(s.logo.originalSrc);
            }
            return { logo: emptyLogo, originalMeta: null, assetKey: newAssetKey() };
        }),
    setProcessedLogo: (dataUrl, width, height) =>
        set((s) => {
            // Revoke a previous *processed* blob (never the pristine original).
            if (
                s.logo.src &&
                s.logo.src !== s.logo.originalSrc &&
                s.logo.src.startsWith("blob:")
            ) {
                URL.revokeObjectURL(s.logo.src);
            }
            return {
                logo: {
                    ...s.logo,
                    src: dataUrl,
                    mime: "image/png",
                    isSvg: false,
                    svgText: null,
                    naturalWidth: width,
                    naturalHeight: height,
                },
                assetKey: newAssetKey(),
            };
        }),
    setProcessedSvg: (svgText, width, height) =>
        set((s) => {
            // Revoke a previous *processed* blob (never the pristine original).
            if (
                s.logo.src &&
                s.logo.src !== s.logo.originalSrc &&
                s.logo.src.startsWith("blob:")
            ) {
                URL.revokeObjectURL(s.logo.src);
            }
            const blob = new Blob([svgText], { type: "image/svg+xml" });
            const src = URL.createObjectURL(blob);
            return {
                logo: {
                    ...s.logo,
                    src,
                    mime: "image/svg+xml",
                    isSvg: true,
                    svgText,
                    naturalWidth: width,
                    naturalHeight: height,
                },
                assetKey: newAssetKey(),
            };
        }),
    restoreOriginal: () =>
        set((s) => {
            if (!s.logo.originalSrc) return {};
            if (
                s.logo.src &&
                s.logo.src !== s.logo.originalSrc &&
                s.logo.src.startsWith("blob:")
            ) {
                URL.revokeObjectURL(s.logo.src);
            }
            // Restore the original metadata too; Apply may have rewritten it.
            return {
                logo: {
                    ...s.logo,
                    src: s.logo.originalSrc,
                    ...(s.originalMeta ?? {}),
                },
                assetKey: newAssetKey(),
            };
        }),
    setAppearance: (patch) =>
        set((s) => ({ appearance: { ...s.appearance, ...patch } })),
    setEnv: (patch) => set((s) => ({ env: { ...s.env, ...patch } })),
    resetAppearance: () => set({ appearance: defaultAppearance }),

    mockups: storedPlacements(),
    setMock: (id, patch) =>
        set((s) => {
            // Revoke a previous custom screenshot blob when replacing it.
            if (
                patch.shot !== undefined &&
                s.mockups[id].shot &&
                s.mockups[id].shot !== patch.shot &&
                s.mockups[id].shot!.startsWith("blob:")
            ) {
                URL.revokeObjectURL(s.mockups[id].shot!);
            }
            return {
                mockups: { ...s.mockups, [id]: { ...s.mockups[id], ...patch } },
            };
        }),
    resetMock: (id) =>
        set((s) => {
            if (s.mockups[id].shot && s.mockups[id].shot!.startsWith("blob:")) {
                URL.revokeObjectURL(s.mockups[id].shot!);
            }
            return {
                mockups: { ...s.mockups, [id]: { ...defaultMockups[id] } },
            };
        }),
}));

/** Convenience selector hooks (stable references, avoid re-render churn). */
export const useLogo = () => useStore((s) => s.logo);
export const useAppearance = () => useStore((s) => s.appearance);
export const useEnv = () => useStore((s) => s.env);

/** The Tailwind class for the current global checkerboard backdrop. */
export const useCheckerClass = () =>
    useStore((s) => (s.checkerDark ? "checkerboard-dark" : "checkerboard"));

/* ------------------------------------------------------------- persistence */

// Settings go to localStorage so they are correct in the first painted frame;
// pixels go to IndexedDB. Writes are debounced because these change on every
// slider move.
const saveAppearance = debounce((a: Appearance) => writeLocal(LS_APPEARANCE, a), 250);
const saveEnv = debounce((e: Environment) => writeLocal(LS_ENV, e), 250);
const saveChecker = debounce(
    (dark: boolean, userSet: boolean) =>
        writeLocal(LS_CHECKER, { checkerDark: dark, checkerUserSet: userSet }),
    250,
);
// Placements only: a `shot` object URL is meaningless after a reload; its bytes
// go to IndexedDB below.
const savePlacements = debounce((mockups: Record<DeviceId, MockPlacement>) => {
    writeLocal(LS_MOCKUPS, {
        ios: { x: mockups.ios.x, y: mockups.ios.y, size: mockups.ios.size },
        android: {
            x: mockups.android.x,
            y: mockups.android.y,
            size: mockups.android.size,
        },
    });
}, 250);

/**
 * Signature (key + both URLs) of the last stored logo. Copying bytes out of an
 * object URL is expensive, so it only happens when the image changes; a changed
 * signature also tells a slow read that a newer write overtook it.
 */
let storedLogoSig = "";

async function persistLogo(s: AppState): Promise<void> {
    if (!s.logo.originalSrc) {
        storedLogoSig = "";
        saveSlot(SLOTS.logo, null);
        // Clearing the logo also drops the work derived from it, rather than
        // leaving orphaned data in storage.
        saveSlot(SLOTS.vectorize, null);
        saveSlot(SLOTS.cleanup, null);
        return;
    }
    const sig = `${s.assetKey}|${s.logo.originalSrc}|${s.logo.src ?? ""}`;
    if (sig === storedLogoSig) return;
    storedLogoSig = sig;

    const original = await srcToBlob(s.logo.originalSrc);
    if (!original) return;
    const isProcessed = Boolean(s.logo.src && s.logo.src !== s.logo.originalSrc);
    const working = isProcessed ? await srcToBlob(s.logo.src!) : null;
    // A newer image landed while we were reading; that write owns the slot.
    if (sig !== storedLogoSig) return;

    const meta = s.originalMeta;
    const record: Omit<StoredLogo, "v"> = {
        assetKey: s.assetKey,
        fileName: s.logo.fileName,
        original,
        originalMeta: {
            mime: meta?.mime ?? s.logo.mime,
            isSvg: meta?.isSvg ?? s.logo.isSvg,
            svgText: meta?.svgText ?? s.logo.svgText,
            naturalWidth: meta?.naturalWidth ?? s.logo.naturalWidth,
            naturalHeight: meta?.naturalHeight ?? s.logo.naturalHeight,
        },
        working,
        workingMeta: working
            ? {
                  mime: s.logo.mime,
                  isSvg: s.logo.isSvg,
                  svgText: s.logo.svgText,
                  naturalWidth: s.logo.naturalWidth,
                  naturalHeight: s.logo.naturalHeight,
              }
            : null,
    };
    saveSlot(SLOTS.logo, record, 0);
}

let storedShotSig = "";

async function persistMockShots(s: AppState): Promise<void> {
    const sig = `${s.mockups.ios.shot ?? ""}|${s.mockups.android.shot ?? ""}`;
    if (sig === storedShotSig) return;
    storedShotSig = sig;
    if (!s.mockups.ios.shot && !s.mockups.android.shot) {
        saveSlot(SLOTS.mockShots, null);
        return;
    }
    const [ios, android] = await Promise.all([
        s.mockups.ios.shot ? srcToBlob(s.mockups.ios.shot) : null,
        s.mockups.android.shot ? srcToBlob(s.mockups.android.shot) : null,
    ]);
    if (sig !== storedShotSig) return;
    saveSlot(SLOTS.mockShots, { ios, android }, 0);
}

useStore.subscribe((s, prev) => {
    if (s.appearance !== prev.appearance) saveAppearance(s.appearance);
    if (s.env !== prev.env) saveEnv(s.env);
    if (s.checkerDark !== prev.checkerDark || s.checkerUserSet !== prev.checkerUserSet)
        saveChecker(s.checkerDark, s.checkerUserSet);
    if (s.mockups !== prev.mockups) {
        savePlacements(s.mockups);
        void persistMockShots(s);
    }
    if (s.logo !== prev.logo || s.assetKey !== prev.assetKey) void persistLogo(s);
});
