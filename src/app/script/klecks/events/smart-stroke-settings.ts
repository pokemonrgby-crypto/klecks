import { LocalStorage } from '../../bb/base/local-storage';
import { TSmartStrokeTrimSuggestion } from './smart-stroke.types';

export type TSmartStrokeMode = 'off' | 'weak' | 'normal' | 'strong';
export type TSmartStrokeTarget = 'current' | 'previous';

const STORAGE_KEY = 'smartStrokeMode';
const TARGET_STORAGE_KEY = 'smartStrokeTarget';
const VALID_MODES: readonly TSmartStrokeMode[] = ['off', 'weak', 'normal', 'strong'];
const VALID_TARGETS: readonly TSmartStrokeTarget[] = ['current', 'previous'];

function readStoredMode(): TSmartStrokeMode {
    const stored = LocalStorage.getItem(STORAGE_KEY) as TSmartStrokeMode | null;
    return stored && VALID_MODES.includes(stored) ? stored : 'off';
}

function readStoredTarget(): TSmartStrokeTarget {
    const stored = LocalStorage.getItem(TARGET_STORAGE_KEY) as TSmartStrokeTarget | null;
    return stored && VALID_TARGETS.includes(stored) ? stored : 'current';
}

let mode: TSmartStrokeMode = readStoredMode();
let target: TSmartStrokeTarget = readStoredTarget();
let pendingTrim: TSmartStrokeTrimSuggestion | undefined;

/**
 * Shared settings for smart-stroke correction.
 *
 * `previous` means the just-committed previous stroke may also be corrected.
 * Older strokes are intentionally not rewritten yet because later raster
 * operations could overlap them and make a safe replay ambiguous.
 */
export const SmartStrokeSettings = {
    getMode(): TSmartStrokeMode {
        return mode;
    },

    setMode(nextMode: TSmartStrokeMode): void {
        mode = VALID_MODES.includes(nextMode) ? nextMode : 'off';
        LocalStorage.setItem(STORAGE_KEY, mode);
        pendingTrim = undefined;
    },

    getTarget(): TSmartStrokeTarget {
        return target;
    },

    setTarget(nextTarget: TSmartStrokeTarget): void {
        target = VALID_TARGETS.includes(nextTarget) ? nextTarget : 'current';
        LocalStorage.setItem(TARGET_STORAGE_KEY, target);
        pendingTrim = undefined;
    },

    getMinTrimConfidence(): number {
        if (mode === 'weak') {
            return 0.72;
        }
        if (mode === 'normal') {
            return 0.38;
        }
        if (mode === 'strong') {
            return 0.12;
        }
        return Number.POSITIVE_INFINITY;
    },

    setPendingTrim(trim: TSmartStrokeTrimSuggestion | undefined): void {
        pendingTrim = trim ? { ...trim, intersection: { ...trim.intersection } } : undefined;
    },

    clearPendingTrim(): void {
        pendingTrim = undefined;
    },

    consumePendingTrim(): TSmartStrokeTrimSuggestion | undefined {
        const result = pendingTrim;
        pendingTrim = undefined;
        return result
            ? {
                  ...result,
                  intersection: { ...result.intersection },
              }
            : undefined;
    },
};
