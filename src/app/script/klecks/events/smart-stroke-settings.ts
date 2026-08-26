import { LocalStorage } from '../../bb/base/local-storage';

export type TSmartStrokeMode = 'off' | 'weak' | 'normal' | 'strong';
export type TSmartStrokeTarget = 'current' | 'both';

const STORAGE_KEY = 'smartStrokeMode';
const TARGET_STORAGE_KEY = 'smartStrokeTarget';
const VALID_MODES: readonly TSmartStrokeMode[] = ['off', 'weak', 'normal', 'strong'];
const VALID_TARGETS: readonly TSmartStrokeTarget[] = ['current', 'both'];

function readStoredMode(): TSmartStrokeMode {
    const stored = LocalStorage.getItem(STORAGE_KEY) as TSmartStrokeMode | null;
    return stored && VALID_MODES.includes(stored) ? stored : 'off';
}

function readStoredTarget(): TSmartStrokeTarget {
    const stored = LocalStorage.getItem(TARGET_STORAGE_KEY);
    // v2 stored `previous`; migrate that meaning to the clearer v3 `both`.
    if (stored === 'previous') {
        return 'both';
    }
    return stored && VALID_TARGETS.includes(stored as TSmartStrokeTarget)
        ? (stored as TSmartStrokeTarget)
        : 'current';
}

let mode: TSmartStrokeMode = readStoredMode();
let target: TSmartStrokeTarget = readStoredTarget();

/** Shared settings for smart-stroke correction. */
export const SmartStrokeSettings = {
    getMode(): TSmartStrokeMode {
        return mode;
    },

    setMode(nextMode: TSmartStrokeMode): void {
        mode = VALID_MODES.includes(nextMode) ? nextMode : 'off';
        LocalStorage.setItem(STORAGE_KEY, mode);
    },

    getTarget(): TSmartStrokeTarget {
        return target;
    },

    setTarget(nextTarget: TSmartStrokeTarget): void {
        target = VALID_TARGETS.includes(nextTarget) ? nextTarget : 'current';
        LocalStorage.setItem(TARGET_STORAGE_KEY, target);
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

    getMinConnectConfidence(): number {
        if (mode === 'weak') {
            return 0.8;
        }
        if (mode === 'normal') {
            return 0.58;
        }
        if (mode === 'strong') {
            return 0.34;
        }
        return Number.POSITIVE_INFINITY;
    },
};
