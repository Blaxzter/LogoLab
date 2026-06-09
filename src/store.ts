import { create } from "zustand";
import type { Appearance, Environment, LogoAsset } from "./types";

export type Tab = "preview" | "cleanup" | "vectorize" | "export";

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
    tab: Tab;
    logo: LogoAsset;
    /** Snapshot of the original asset metadata (set on upload, used by Reset). */
    originalMeta: OriginalMeta | null;
    appearance: Appearance;
    env: Environment;

    setTab: (tab: Tab) => void;
    setLogo: (logo: Partial<LogoAsset>) => void;
    clearLogo: () => void;
    /** Replace the working image (e.g. after background removal) with a PNG data URL. */
    setProcessedLogo: (dataUrl: string, width: number, height: number) => void;
    /** Restore the working image back to the pristine upload. */
    restoreOriginal: () => void;
    setAppearance: (patch: Partial<Appearance>) => void;
    setEnv: (patch: Partial<Environment>) => void;
    resetAppearance: () => void;

    mockups: Record<DeviceId, MockPlacement>;
    setMock: (id: DeviceId, patch: Partial<MockPlacement>) => void;
    resetMock: (id: DeviceId) => void;
}

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

export const useStore = create<AppState>((set) => ({
    tab: "preview",
    logo: emptyLogo,
    originalMeta: null,
    appearance: defaultAppearance,
    env: defaultEnv,

    setTab: (tab) => set({ tab }),
    setLogo: (patch) =>
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
            return { logo, originalMeta };
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
            return { logo: emptyLogo, originalMeta: null };
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
            // Restore src AND the original metadata (Apply may have rewritten
            // isSvg/svgText/mime/dimensions to the processed PNG's values).
            return {
                logo: {
                    ...s.logo,
                    src: s.logo.originalSrc,
                    ...(s.originalMeta ?? {}),
                },
            };
        }),
    setAppearance: (patch) =>
        set((s) => ({ appearance: { ...s.appearance, ...patch } })),
    setEnv: (patch) => set((s) => ({ env: { ...s.env, ...patch } })),
    resetAppearance: () => set({ appearance: defaultAppearance }),

    mockups: {
        ios: { ...defaultMockups.ios },
        android: { ...defaultMockups.android },
    },
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
