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
 */
export class SmartStrokeRecorder {
    private readonly maxRecentStrokes: number;
    private currentSamples: TSmartStrokeSample[] | undefined;
    private currentBrushRadius: number = 1;
    private recentStrokes: TSmartStroke[] = [];
    private lastAnalysis: TSmartStrokeAnalysis = { suggestions: [] };

    constructor(maxRecentStrokes: number = 64) {
        this.maxRecentStrokes = Math.max(1, Math.floor(maxRecentStrokes));
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

        this.lastAnalysis = analyzeSmartStroke(stroke, this.recentStrokes);
        this.recentStrokes.push(stroke);
        while (this.recentStrokes.length > this.maxRecentStrokes) {
            this.recentStrokes.shift();
        }
        this.currentSamples = undefined;
        return stroke;
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
