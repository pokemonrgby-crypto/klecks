import { LocalStorage } from '../../bb/base/local-storage';
import { TSmartStrokeTrimSuggestion } from './smart-stroke.types';

export type TSmartStrokeMode = 'off' | 'weak' | 'normal' | 'strong';

const STORAGE_KEY = 'smartStrokeMode';
const VALID_MODES: readonly TSmartStrokeMode[] = ['off', 'weak', 'normal', 'strong'];

function readStoredMode(): TSmartStrokeMode {
    const stored = LocalStorage.getItem(STORAGE_KEY) as TSmartStrokeMode | null;
    return stored && VALID_MODES.includes(stored) ? stored : 'off';
}

let mode: TSmartStrokeMode = readStoredMode();
let pendingTrim: TSmartStrokeTrimSuggestion | undefined;

/**
 * Small shared state for the first smart-stroke correction feature.
 *
 * The selected mode is persisted locally. A trim suggestion only lives for
 * the current pointer-up -> brush endLine handoff and is consumed once.
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

    getMinTrimConfidence(): number {
        if (mode === 'weak') {
            return 0.82;
        }
        if (mode === 'normal') {
            return 0.62;
        }
        if (mode === 'strong') {
            return 0.42;
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
