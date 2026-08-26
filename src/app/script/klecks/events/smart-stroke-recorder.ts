import { analyzeSmartStroke } from './smart-stroke-analyzer';
import {
    TSmartStroke,
    TSmartStrokeAnalysis,
    TSmartStrokeSample,
} from './smart-stroke.types';

/**
 * Keeps a small in-memory sidecar history of recent raster brush strokes.
 *
 * Nothing here changes the layer bitmap. The recorder exists so a future
 * post-correction step can inspect the just-finished stroke without turning
 * the painting layer into a vector layer.
 *
 * Recording intentionally stays cheap: geometry analysis is opt-in and long
 * strokes are progressively downsampled to keep tablet memory/CPU bounded.
 */
export class SmartStrokeRecorder {
    private readonly maxRecentStrokes: number;
    private readonly maxSamplesPerStroke: number;
    private currentSamples: TSmartStrokeSample[] | undefined;
    private currentBrushRadius: number = 1;
    private recentStrokes: TSmartStroke[] = [];
    private lastAnalysis: TSmartStrokeAnalysis = { suggestions: [] };

    constructor(maxRecentStrokes: number = 32, maxSamplesPerStroke: number = 2048) {
        this.maxRecentStrokes = Math.max(1, Math.floor(maxRecentStrokes));
        this.maxSamplesPerStroke = Math.max(32, Math.floor(maxSamplesPerStroke));
    }

    private compactCurrentSamples(): void {
        if (!this.currentSamples || this.currentSamples.length <= this.maxSamplesPerStroke) {
            return;
        }

        const oldSamples = this.currentSamples;
        const lastIndex = oldSamples.length - 1;
        const compacted: TSmartStrokeSample[] = [];

        for (let i = 0; i <= lastIndex; i += 2) {
            compacted.push(oldSamples[i]);
        }

        // Preserve the actual endpoint even when the final index was skipped.
        if (compacted[compacted.length - 1] !== oldSamples[lastIndex]) {
            compacted.push(oldSamples[lastIndex]);
        }
        this.currentSamples = compacted;
    }

    begin(sample: TSmartStrokeSample, brushRadius: number): void {
        this.currentSamples = [{ ...sample }];
        this.currentBrushRadius = Math.max(0.1, brushRadius);
        this.lastAnalysis = { suggestions: [] };
    }

    add(sample: TSmartStrokeSample): void {
        if (!this.currentSamples) {
            return;
        }
        const prev = this.currentSamples[this.currentSamples.length - 1];
        if (
            prev &&
            prev.x === sample.x &&
            prev.y === sample.y &&
            prev.time === sample.time &&
            prev.pressure === sample.pressure
        ) {
            return;
        }
        this.currentSamples.push({ ...sample });
        this.compactCurrentSamples();
    }

    end(endedAt: number): TSmartStroke | undefined {
        if (!this.currentSamples || this.currentSamples.length === 0) {
            this.currentSamples = undefined;
            this.lastAnalysis = { suggestions: [] };
            return undefined;
        }

        const first = this.currentSamples[0];
        const stroke: TSmartStroke = {
            samples: this.currentSamples.map((item) => ({ ...item })),
            startedAt: first.time,
            endedAt,
            pointerId: first.pointerId,
            pointerType: first.pointerType,
            brushRadius: this.currentBrushRadius,
        };

        // Do not run O(n*m) geometry checks after every pen-up. Analysis is
        // explicitly requested only when the smart-correction feature needs it.
        this.lastAnalysis = { suggestions: [] };
        this.recentStrokes.push(stroke);
        while (this.recentStrokes.length > this.maxRecentStrokes) {
            this.recentStrokes.shift();
        }
        this.currentSamples = undefined;
        return stroke;
    }

    analyzeLastStroke(maxReferenceStrokes: number = 16): TSmartStrokeAnalysis {
        if (this.recentStrokes.length === 0) {
            this.lastAnalysis = { suggestions: [] };
            return this.getLastAnalysis();
        }

        const currentIndex = this.recentStrokes.length - 1;
        const current = this.recentStrokes[currentIndex];
        const referenceStart = Math.max(0, currentIndex - Math.max(1, maxReferenceStrokes));
        const references = this.recentStrokes.slice(referenceStart, currentIndex);
        this.lastAnalysis = analyzeSmartStroke(current, references);
        return this.getLastAnalysis();
    }

    cancel(): void {
        this.currentSamples = undefined;
        this.lastAnalysis = { suggestions: [] };
    }

    clear(): void {
        this.cancel();
        this.recentStrokes = [];
    }

    getLastStroke(): TSmartStroke | undefined {
        const stroke = this.recentStrokes[this.recentStrokes.length - 1];
        if (!stroke) {
            return undefined;
        }
        return {
            ...stroke,
            samples: stroke.samples.map((item) => ({ ...item })),
        };
    }

    getRecentStrokes(): readonly TSmartStroke[] {
        return this.recentStrokes;
    }

    getLastAnalysis(): TSmartStrokeAnalysis {
        return {
            suggestions: this.lastAnalysis.suggestions.map((item) => ({ ...item })),
        };
    }
}
