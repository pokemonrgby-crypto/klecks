import { BB } from '../../bb/bb';
import { ALPHA_IM_ARR } from './brushes-common';
import { TPressureInput, TRgb } from '../kl-types';
import { BezierLine } from '../../bb/math/line';
import { HISTORY_TILE_SIZE, KlHistory } from '../history/kl-history';
import { getPushableLayerChange } from '../history/push-helpers/get-pushable-layer-change';
import { canvasAndChangedTilesToLayerTiles } from '../history/push-helpers/canvas-to-layer-tiles';
import { getChangedTiles, updateChangedTiles } from '../history/push-helpers/changed-tiles';
import { getTileFromCanvas } from '../history/push-helpers/get-tile-from-canvas';
import { MultiPolygon } from 'polygon-clipping';
import { getSelectionPath2d } from '../../bb/multi-polygon/get-selection-path-2d';
import { intersectBounds } from '../../bb/math/math';
import { getMultiPolyBounds } from '../../bb/multi-polygon/get-multi-polygon-bounds';
import { TIndexBounds } from '../../bb/bb-types';
import { SmartStrokeSettings } from '../events/smart-stroke-settings';
import {
    analyzeSmartStroke,
    findSmartStrokeTailIntersection,
} from '../events/smart-stroke-analyzer';
import { TSmartStroke, TSmartStrokeTrimSuggestion } from '../events/smart-stroke.types';

const ALPHA_CIRCLE = 0;
const ALPHA_CHALK = 1;
const ALPHA_CAL = 2; // calligraphy
const ALPHA_SQUARE = 3;

const TWO_PI = 2 * Math.PI;

type TPenReplaySettings = {
    hasOpacityPressure: boolean;
    hasScatterPressure: boolean;
    hasSizePressure: boolean;
    size: number;
    spacing: number;
    opacity: number;
    scatter: number;
    color: TRgb;
    alphaId: number;
    lockLayerAlpha: boolean;
};

type TEditableSmartStroke = {
    stroke: TSmartStroke;
    inputs: TPressureInput[];
    beforeTiles: Map<number, ImageData>;
    settings: TPenReplaySettings;
    selectionPath?: Path2D;
    selectionBounds?: TIndexBounds;
    historyChangeCount: number;
};

type TSmartTrimDecision = {
    target: 'current' | 'previous';
    intersection: { x: number; y: number };
};

export class PenBrush {
    private context: CanvasRenderingContext2D = {} as CanvasRenderingContext2D;
    private klHistory: KlHistory = {} as KlHistory;

    private settingHasOpacityPressure: boolean = false;
    private settingHasScatterPressure: boolean = false;
    private settingHasSizePressure: boolean = true;
    private settingSize: number = 2;
    private settingSpacing: number = 0.8489;
    private settingOpacity: number = 1;
    private settingScatter: number = 0;
    private settingColor: TRgb = {} as TRgb;
    private settingColorStr: string = '';
    private settingAlphaId: number = ALPHA_CIRCLE;
    private settingLockLayerAlpha: boolean = false;

    private hasDrawnDot: boolean = false;
    private lineToolLastDot: number = 0;
    private lastInput: TPressureInput = { x: 0, y: 0, pressure: 0 };
    private lastInput2: TPressureInput = { x: 0, y: 0, pressure: 0 };
    private inputArr: TPressureInput[] = [];
    private inputIsDrawing: boolean = false;
    private bezierLine: BezierLine | null = null;

    // mipmapping
    private readonly alphaCanvas128: HTMLCanvasElement = BB.canvas(128, 128);
    private readonly alphaCanvas64: HTMLCanvasElement = BB.canvas(64, 64);
    private readonly alphaCanvas32: HTMLCanvasElement = BB.canvas(32, 32);
    private readonly alphaOpacityArr: number[] = [1, 0.9, 1, 1];

    private changedTiles: boolean[] = [];

    // Smart trim stores only tiles touched by the current stroke. This avoids
    // cloning a full high-resolution layer for every pen-down.
    private strokeStartTiles = new Map<number, ImageData>();
    private isCapturingStrokeStartTiles: boolean = false;
    private recentRenderedStrokes: TSmartStroke[] = [];
    private lastEditableStroke: TEditableSmartStroke | undefined;
    private lastBrushHistoryChangeCount: number | undefined;

    private selection: MultiPolygon | undefined;
    private selectionPath: Path2D | undefined;
    private selectionBounds: TIndexBounds | undefined;

    private captureStrokeStartTiles(changedTiles: boolean[]): void {
        if (!this.isCapturingStrokeStartTiles) {
            return;
        }
        const canvas = this.context.canvas;
        const tilesX = Math.ceil(canvas.width / HISTORY_TILE_SIZE);
        changedTiles.forEach((isChanged, index) => {
            if (!isChanged || this.strokeStartTiles.has(index)) {
                return;
            }
            const col = index % tilesX;
            const row = Math.floor(index / tilesX);
            this.strokeStartTiles.set(index, getTileFromCanvas(canvas, col, row));
        });
    }

    private restoreStrokeStartTiles(): void {
        const tilesX = Math.ceil(this.context.canvas.width / HISTORY_TILE_SIZE);
        this.strokeStartTiles.forEach((tile, index) => {
            const col = index % tilesX;
            const row = Math.floor(index / tilesX);
            this.context.putImageData(tile, col * HISTORY_TILE_SIZE, row * HISTORY_TILE_SIZE);
        });
    }


    private createRenderedSmartStroke(
        inputs: readonly TPressureInput[],
        brushRadius: number = this.settingSize,
    ): TSmartStroke | undefined {
        if (inputs.length < 3) {
            return undefined;
        }

        const maxSamples = 1024;
        const stride = Math.max(1, Math.ceil(inputs.length / maxSamples));
        const compacted: TPressureInput[] = [];
        for (let i = 0; i < inputs.length; i += stride) {
            compacted.push(inputs[i]);
        }
        const last = inputs[inputs.length - 1];
        if (compacted[compacted.length - 1] !== last) {
            compacted.push(last);
        }

        const samples = compacted.map((item, index) => ({
            x: item.x,
            y: item.y,
            pressure: item.pressure,
            time: index,
            isCoalesced: false,
            pointerId: 0,
            pointerType: 'pen' as const,
        }));
        return {
            samples,
            startedAt: 0,
            endedAt: samples.length - 1,
            pointerId: 0,
            pointerType: 'pen',
            brushRadius,
        };
    }

    private getTrimLimits(): { maxDistance: number; minConfidence: number } {
        const mode = SmartStrokeSettings.getMode();
        if (mode === 'weak') {
            return {
                maxDistance: Math.max(16, Math.min(48, this.settingSize * 6)),
                minConfidence: 0.55,
            };
        }
        if (mode === 'normal') {
            return {
                maxDistance: Math.max(32, Math.min(96, this.settingSize * 12)),
                minConfidence: 0.25,
            };
        }
        if (mode === 'strong') {
            return {
                maxDistance: Math.max(56, Math.min(180, this.settingSize * 20)),
                minConfidence: 0.06,
            };
        }
        return { maxDistance: 0, minConfidence: Number.POSITIVE_INFINITY };
    }

    private getRenderedTrimSuggestion(
        current: TSmartStroke,
    ): TSmartStrokeTrimSuggestion | undefined {
        if (SmartStrokeSettings.getMode() === 'off' || this.recentRenderedStrokes.length === 0) {
            return undefined;
        }

        const limits = this.getTrimLimits();
        const analysis = analyzeSmartStroke(
            current,
            this.recentRenderedStrokes.slice(-16),
            { maxTrimDistance: limits.maxDistance },
        );
        const suggestion = analysis.suggestions.find((item) => item.type === 'trim');
        return suggestion?.type === 'trim' && suggestion.confidence >= limits.minConfidence
            ? suggestion
            : undefined;
    }

    private getSmartTrimDecision(current: TSmartStroke): TSmartTrimDecision | undefined {
        const currentSuggestion = this.getRenderedTrimSuggestion(current);
        if (SmartStrokeSettings.getTarget() !== 'previous' || !this.lastEditableStroke) {
            return currentSuggestion
                ? { target: 'current', intersection: currentSuggestion.intersection }
                : undefined;
        }

        if (this.lastEditableStroke.historyChangeCount !== this.klHistory.getChangeCount()) {
            this.lastEditableStroke = undefined;
            return currentSuggestion
                ? { target: 'current', intersection: currentSuggestion.intersection }
                : undefined;
        }

        const crossing = findSmartStrokeTailIntersection(current, this.lastEditableStroke.stroke);
        if (!crossing) {
            return currentSuggestion
                ? { target: 'current', intersection: currentSuggestion.intersection }
                : undefined;
        }

        const limits = this.getTrimLimits();
        const previousConfidence = Math.max(
            0,
            1 - crossing.referenceTailLength / Math.max(1, limits.maxDistance),
        );
        const previousQualifies =
            crossing.referenceTailLength > 0.5 &&
            crossing.referenceTailLength <= limits.maxDistance &&
            previousConfidence >= limits.minConfidence;

        if (
            previousQualifies &&
            (!currentSuggestion || crossing.referenceTailLength < currentSuggestion.overshootLength * 0.9)
        ) {
            return { target: 'previous', intersection: crossing.intersection };
        }

        return currentSuggestion
            ? { target: 'current', intersection: currentSuggestion.intersection }
            : undefined;
    }

    private rememberRenderedStroke(stroke: TSmartStroke | undefined): void {
        if (!stroke) {
            return;
        }
        this.recentRenderedStrokes.push(stroke);
        while (this.recentRenderedStrokes.length > 32) {
            this.recentRenderedStrokes.shift();
        }
    }

    private captureReplaySettings(): TPenReplaySettings {
        return {
            hasOpacityPressure: this.settingHasOpacityPressure,
            hasScatterPressure: this.settingHasScatterPressure,
            hasSizePressure: this.settingHasSizePressure,
            size: this.settingSize,
            spacing: this.settingSpacing,
            opacity: this.settingOpacity,
            scatter: this.settingScatter,
            color: { ...this.settingColor },
            alphaId: this.settingAlphaId,
            lockLayerAlpha: this.settingLockLayerAlpha,
        };
    }

    private applyReplaySettings(settings: TPenReplaySettings): void {
        this.settingHasOpacityPressure = settings.hasOpacityPressure;
        this.settingHasScatterPressure = settings.hasScatterPressure;
        this.settingHasSizePressure = settings.hasSizePressure;
        this.settingSize = settings.size;
        this.settingSpacing = settings.spacing;
        this.settingOpacity = settings.opacity;
        this.settingScatter = settings.scatter;
        this.settingColor = { ...settings.color };
        this.settingColorStr = `rgb(${settings.color.r},${settings.color.g},${settings.color.b})`;
        this.settingAlphaId = settings.alphaId;
        this.settingLockLayerAlpha = settings.lockLayerAlpha;
        this.updateAlphaCanvas();
    }

    private restoreTileMap(tileMap: Map<number, ImageData>): void {
        const tilesX = Math.ceil(this.context.canvas.width / HISTORY_TILE_SIZE);
        tileMap.forEach((tile, index) => {
            const col = index % tilesX;
            const row = Math.floor(index / tilesX);
            this.context.putImageData(tile, col * HISTORY_TILE_SIZE, row * HISTORY_TILE_SIZE);
        });
    }

    private snapshotTileIndices(indices: Iterable<number>): Map<number, ImageData> {
        const result = new Map<number, ImageData>();
        const canvas = this.context.canvas;
        const tilesX = Math.ceil(canvas.width / HISTORY_TILE_SIZE);
        for (const index of indices) {
            const col = index % tilesX;
            const row = Math.floor(index / tilesX);
            result.set(index, getTileFromCanvas(canvas, col, row));
        }
        return result;
    }

    private changedTilesFromMaps(...maps: Map<number, ImageData>[]): boolean[] {
        const result: boolean[] = [];
        maps.forEach((map) => {
            map.forEach((_value, index) => {
                result[index] = true;
            });
        });
        return result;
    }

    private createTrimmedInputArrFrom(
        inputs: readonly TPressureInput[],
        trimPoint: { x: number; y: number },
        brushSize: number,
    ): TPressureInput[] | undefined {
        if (inputs.length < 3) {
            return undefined;
        }

        let best:
            | {
                  index: number;
                  t: number;
                  distanceSq: number;
              }
            | undefined;

        for (let i = inputs.length - 2; i >= 0; i--) {
            const a = inputs[i];
            const b = inputs[i + 1];
            const dx = b.x - a.x;
            const dy = b.y - a.y;
            const lenSq = dx * dx + dy * dy;
            if (lenSq < 0.000001) {
                continue;
            }
            const t = BB.clamp(
                ((trimPoint.x - a.x) * dx + (trimPoint.y - a.y) * dy) / lenSq,
                0,
                1,
            );
            const px = a.x + dx * t;
            const py = a.y + dy * t;
            const distanceSq = (trimPoint.x - px) ** 2 + (trimPoint.y - py) ** 2;
            if (!best || distanceSq < best.distanceSq - 0.0001) {
                best = { index: i, t, distanceSq };
            }
        }

        const maxProjectionDistance = Math.max(4, Math.min(24, brushSize * 2.5));
        if (!best || Math.sqrt(best.distanceSq) > maxProjectionDistance) {
            return undefined;
        }

        const a = inputs[best.index];
        const b = inputs[best.index + 1];
        const pressure = BB.mix(a.pressure, b.pressure, best.t);
        const result = inputs.slice(0, best.index + 1).map((item) => ({ ...item }));
        result.push({ x: trimPoint.x, y: trimPoint.y, pressure });
        if (result.length >= inputs.length && best.t > 0.98) {
            return undefined;
        }
        return result;
    }

    private replayStrokeRaster(p: {
        inputs: readonly TPressureInput[];
        settings: TPenReplaySettings;
        selectionPath?: Path2D;
        selectionBounds?: TIndexBounds;
    }): boolean[] {
        if (p.inputs.length < 2 || p.settings.alphaId !== ALPHA_CIRCLE || p.settings.scatter !== 0) {
            return [];
        }

        const savedSettings = this.captureReplaySettings();
        const savedSelection = this.selection;
        const savedSelectionPath = this.selectionPath;
        const savedSelectionBounds = this.selectionBounds;
        const savedChangedTiles = this.changedTiles;
        const savedStrokeStartTiles = this.strokeStartTiles;
        const savedIsCapturing = this.isCapturingStrokeStartTiles;
        const savedHasDrawnDot = this.hasDrawnDot;
        const savedLineToolLastDot = this.lineToolLastDot;
        const savedLastInput = { ...this.lastInput };
        const savedLastInput2 = { ...this.lastInput2 };
        const savedInputArr = this.inputArr;
        const savedInputIsDrawing = this.inputIsDrawing;
        const savedBezierLine = this.bezierLine;

        try {
            this.applyReplaySettings(p.settings);
            this.selection = undefined;
            this.selectionPath = p.selectionPath;
            this.selectionBounds = p.selectionBounds;
            this.changedTiles = [];
            this.strokeStartTiles = new Map();
            this.isCapturingStrokeStartTiles = false;
            this.hasDrawnDot = false;
            this.inputArr = [];
            this.inputIsDrawing = true;
            this.bezierLine = null;

            const first = p.inputs[0];
            let pressure = BB.clamp(first.pressure, 0, 1);
            let localOpacity = this.calcOpacity(pressure);
            let localSize = this.settingHasSizePressure
                ? Math.max(0.1, pressure * this.settingSize)
                : Math.max(0.1, this.settingSize);
            this.context.save();
            this.selectionPath && this.context.clip(this.selectionPath);
            this.drawDot(first.x, first.y, localSize, localOpacity, 0);
            this.context.restore();
            this.lineToolLastDot = localSize * this.settingSpacing;
            this.lastInput = { x: first.x, y: first.y, pressure };
            this.lastInput2 = { x: first.x, y: first.y, pressure };
            this.inputArr = [{ ...first }];

            for (let i = 1; i < p.inputs.length; i++) {
                const item = p.inputs[i];
                pressure = BB.clamp(item.pressure, 0, 1);
                localSize = this.settingHasSizePressure
                    ? Math.max(0.1, this.lastInput.pressure * this.settingSize)
                    : Math.max(0.1, this.settingSize);
                this.context.save();
                this.selectionPath && this.context.clip(this.selectionPath);
                this.continueLine(item.x, item.y, localSize, this.lastInput.pressure);
                this.context.restore();
                this.lastInput2 = { ...this.lastInput };
                this.lastInput = { x: item.x, y: item.y, pressure };
                this.inputArr.push({ ...item });
            }

            localSize = this.settingHasSizePressure
                ? Math.max(0.1, this.lastInput.pressure * this.settingSize)
                : Math.max(0.1, this.settingSize);
            this.context.save();
            this.selectionPath && this.context.clip(this.selectionPath);
            this.continueLine(null, null, localSize, this.lastInput.pressure);
            this.context.restore();
            this.inputIsDrawing = false;
            this.bezierLine = null;
            return [...this.changedTiles];
        } finally {
            this.applyReplaySettings(savedSettings);
            this.selection = savedSelection;
            this.selectionPath = savedSelectionPath;
            this.selectionBounds = savedSelectionBounds;
            this.changedTiles = savedChangedTiles;
            this.strokeStartTiles = savedStrokeStartTiles;
            this.isCapturingStrokeStartTiles = savedIsCapturing;
            this.hasDrawnDot = savedHasDrawnDot;
            this.lineToolLastDot = savedLineToolLastDot;
            this.lastInput = savedLastInput;
            this.lastInput2 = savedLastInput2;
            this.inputArr = savedInputArr;
            this.inputIsDrawing = savedInputIsDrawing;
            this.bezierLine = savedBezierLine;
        }
    }

    private applyCurrentSmartTrim(p: {
        inputs: readonly TPressureInput[];
        beforeTiles: Map<number, ImageData>;
        settings: TPenReplaySettings;
        selectionPath?: Path2D;
        selectionBounds?: TIndexBounds;
        intersection: { x: number; y: number };
    }): TPressureInput[] | undefined {
        const trimmed = this.createTrimmedInputArrFrom(
            p.inputs,
            p.intersection,
            p.settings.size,
        );
        if (!trimmed || p.beforeTiles.size === 0) {
            return undefined;
        }
        this.restoreTileMap(p.beforeTiles);
        this.replayStrokeRaster({
            inputs: trimmed,
            settings: p.settings,
            selectionPath: p.selectionPath,
            selectionBounds: p.selectionBounds,
        });
        this.changedTiles = this.changedTilesFromMaps(p.beforeTiles);
        return trimmed;
    }

    private applyPreviousSmartTrim(p: {
        currentInputs: readonly TPressureInput[];
        currentBeforeTiles: Map<number, ImageData>;
        currentSettings: TPenReplaySettings;
        currentSelectionPath?: Path2D;
        currentSelectionBounds?: TIndexBounds;
        intersection: { x: number; y: number };
    }): Map<number, ImageData> | undefined {
        const previous = this.lastEditableStroke;
        if (!previous || previous.beforeTiles.size === 0 || p.currentBeforeTiles.size === 0) {
            return undefined;
        }
        const trimmedPrevious = this.createTrimmedInputArrFrom(
            previous.inputs,
            p.intersection,
            previous.settings.size,
        );
        if (!trimmedPrevious) {
            return undefined;
        }

        // Remove the current stroke first, then roll the immediately previous
        // stroke back to its own pre-stroke pixels. No older stroke is rewritten.
        this.restoreTileMap(p.currentBeforeTiles);
        this.restoreTileMap(previous.beforeTiles);
        this.replayStrokeRaster({
            inputs: trimmedPrevious,
            settings: previous.settings,
            selectionPath: previous.selectionPath,
            selectionBounds: previous.selectionBounds,
        });

        // The current stroke's future rollback baseline must include the now
        // corrected previous stroke, otherwise a later correction would revive
        // the old overshoot.
        const correctedCurrentBefore = this.snapshotTileIndices(p.currentBeforeTiles.keys());
        this.replayStrokeRaster({
            inputs: p.currentInputs,
            settings: p.currentSettings,
            selectionPath: p.currentSelectionPath,
            selectionBounds: p.currentSelectionBounds,
        });
        this.changedTiles = this.changedTilesFromMaps(previous.beforeTiles, p.currentBeforeTiles);

        const correctedPreviousStroke = this.createRenderedSmartStroke(
            trimmedPrevious,
            previous.settings.size,
        );
        const historyIndex = this.recentRenderedStrokes.lastIndexOf(previous.stroke);
        if (correctedPreviousStroke && historyIndex >= 0) {
            this.recentRenderedStrokes[historyIndex] = correctedPreviousStroke;
        }
        return correctedCurrentBefore;
    }

    private invalidateSmartHistoryIfNeeded(): void {
        const changeCount = this.klHistory.getChangeCount();
        if (
            this.lastBrushHistoryChangeCount !== undefined &&
            changeCount !== this.lastBrushHistoryChangeCount
        ) {
            this.recentRenderedStrokes = [];
            this.lastEditableStroke = undefined;
        }
    }

    private updateChangedTiles(bounds: TIndexBounds) {
        const boundsWithinSelection = intersectBounds(bounds, this.selectionBounds);
        if (!boundsWithinSelection) {
            return;
        }
        const newlyChangedTiles = getChangedTiles(
            boundsWithinSelection,
            this.context.canvas.width,
            this.context.canvas.height,
        );
        this.captureStrokeStartTiles(newlyChangedTiles);
        this.changedTiles = updateChangedTiles(this.changedTiles, newlyChangedTiles);
    }

    private updateAlphaCanvas() {
        if (this.settingAlphaId === ALPHA_CIRCLE || this.settingAlphaId === ALPHA_SQUARE) {
            return;
        }

        const instructionArr: [HTMLCanvasElement, number][] = [
            [this.alphaCanvas128, 128],
            [this.alphaCanvas64, 64],
            [this.alphaCanvas32, 32],
        ];

        let ctx;

        for (let i = 0; i < instructionArr.length; i++) {
            ctx = BB.ctx(instructionArr[i][0] as any);

            ctx.save();
            ctx.clearRect(0, 0, instructionArr[i][1], instructionArr[i][1]);

            ctx.fillStyle =
                'rgba(' +
                this.settingColor.r +
                ', ' +
                this.settingColor.g +
                ', ' +
                this.settingColor.b +
                ', ' +
                this.alphaOpacityArr[this.settingAlphaId] +
                ')';
            ctx.fillRect(0, 0, instructionArr[i][1], instructionArr[i][1]);

            ctx.globalCompositeOperation = 'destination-in';
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(
                ALPHA_IM_ARR[this.settingAlphaId],
                0,
                0,
                instructionArr[i][1],
                instructionArr[i][1],
            );

            ctx.restore();
        }
    }

    private calcOpacity(pressure: number): number {
        return this.settingOpacity * (this.settingHasOpacityPressure ? pressure * pressure : 1);
    }

    private calcScatter(pressure: number): number {
        return (
            this.settingScatter * this.settingSize * (this.settingHasScatterPressure ? pressure : 1)
        );
    }

    /**
     * @param x
     * @param y
     * @param size
     * @param opacity
     * @param scatter
     * @param angle
     * @param before - [x, y, size, opacity, angle] the drawDot call before
     */
    private drawDot(
        x: number,
        y: number,
        size: number,
        opacity: number,
        scatter: number,
        angle?: number,
        before?: [number, number, number, number, number, number | undefined],
    ): void {
        if (size <= 0) {
            return;
        }

        if (this.settingLockLayerAlpha) {
            this.context.globalCompositeOperation = 'source-atop';
        }

        if (!before || before[3] !== opacity) {
            this.context.globalAlpha = opacity;
        }

        if (
            !before &&
            (this.settingAlphaId === ALPHA_CIRCLE || this.settingAlphaId === ALPHA_SQUARE)
        ) {
            this.context.fillStyle = this.settingColorStr;
        }

        if (scatter > 0) {
            // scatter equally distributed over area of a circle
            const scatterAngleRad = Math.random() * 2 * Math.PI;
            const distance = Math.sqrt(Math.random()) * scatter;
            x += Math.cos(scatterAngleRad) * distance;
            y += Math.sin(scatterAngleRad) * distance;
        }

        const boundsSize =
            this.settingAlphaId === ALPHA_CIRCLE || this.settingAlphaId === ALPHA_CAL
                ? size
                : size * Math.sqrt(2);
        this.updateChangedTiles({
            type: 'index',
            x1: Math.floor(x - boundsSize),
            y1: Math.floor(y - boundsSize),
            x2: Math.ceil(x + boundsSize - 1),
            y2: Math.ceil(y + boundsSize - 1),
        });

        if (this.settingAlphaId === ALPHA_CIRCLE) {
            this.context.beginPath();
            this.context.arc(x, y, size, 0, TWO_PI);
            this.context.closePath();
            this.context.fill();
            this.hasDrawnDot = true;
        } else if (this.settingAlphaId === ALPHA_SQUARE) {
            if (angle !== undefined) {
                this.context.save();
                this.context.translate(x, y);
                this.context.rotate((angle / 180) * Math.PI);
                this.context.fillRect(-size, -size, size * 2, size * 2);
                this.context.restore();
                this.hasDrawnDot = true;
            }
        } else {
            // other brush alphas
            this.context.save();
            this.context.translate(x, y);
            let targetMipmap = this.alphaCanvas128;
            if (size <= 32 && size > 16) {
                targetMipmap = this.alphaCanvas64;
            } else if (size <= 16) {
                targetMipmap = this.alphaCanvas32;
            }
            this.context.scale(size, size);
            if (this.settingAlphaId === ALPHA_CHALK) {
                this.context.rotate(((x + y) * 53123) % TWO_PI); // without mod it sometimes looks different
            }
            this.context.drawImage(targetMipmap, -1, -1, 2, 2);

            this.context.restore();
            this.hasDrawnDot = true;
        }
    }

    // continueLine
    private continueLine(x: number | null, y: number | null, size: number, pressure: number): void {
        if (this.bezierLine === null) {
            this.bezierLine = new BB.BezierLine();
            this.bezierLine.add(this.lastInput.x, this.lastInput.y, 0, () => {});
        }

        const drawArr: [number, number, number, number, number, number | undefined][] = []; //draw instructions. will be all drawn at once

        const dotCallback = (val: {
            x: number;
            y: number;
            t: number;
            angle?: number;
            dAngle: number;
        }): void => {
            const localPressure = BB.mix(this.lastInput2.pressure, pressure, val.t);
            const localOpacity = this.calcOpacity(localPressure);
            const localSize = Math.max(
                0.1,
                this.settingSize * (this.settingHasSizePressure ? localPressure : 1),
            );
            const localScatter = this.calcScatter(localPressure);
            drawArr.push([val.x, val.y, localSize, localOpacity, localScatter, val.angle]);
        };

        const localSpacing = size * this.settingSpacing;
        if (x === null || y === null) {
            this.bezierLine.addFinal(localSpacing, dotCallback);
        } else {
            this.bezierLine.add(x, y, localSpacing, dotCallback);
        }

        // execute draw instructions
        this.context.save();
        let before: (typeof drawArr)[number] | undefined = undefined;
        for (let i = 0; i < drawArr.length; i++) {
            const item = drawArr[i];
            this.drawDot(item[0], item[1], item[2], item[3], item[4], item[5], before);
            before = item;
        }
        this.context.restore();
    }

    // ----------------------------------- public -----------------------------------
    constructor() {}

    // ---- interface ----

    startLine(x: number, y: number, p: number): void {
        this.invalidateSmartHistoryIfNeeded();
        this.selection = this.klHistory.getComposed().selection.value;
        this.selectionPath = this.selection ? getSelectionPath2d(this.selection) : undefined;
        this.selectionBounds = this.selection
            ? getMultiPolyBounds(this.selection, 'index')
            : undefined;

        this.changedTiles = [];
        this.strokeStartTiles.clear();
        this.isCapturingStrokeStartTiles =
            SmartStrokeSettings.getMode() !== 'off' &&
            this.settingAlphaId === ALPHA_CIRCLE &&
            this.settingScatter === 0;
        p = BB.clamp(p, 0, 1);
        const localOpacity = this.calcOpacity(p);
        const localSize = this.settingHasSizePressure
            ? Math.max(0.1, p * this.settingSize)
            : Math.max(0.1, this.settingSize);
        const localScatter = this.calcScatter(p);

        this.hasDrawnDot = false;

        this.inputIsDrawing = true;
        this.context.save();
        this.selectionPath && this.context.clip(this.selectionPath);
        this.drawDot(x, y, localSize, localOpacity, localScatter);
        this.context.restore();

        this.lineToolLastDot = localSize * this.settingSpacing;
        this.lastInput.x = x;
        this.lastInput.y = y;
        this.lastInput.pressure = p;
        this.lastInput2.pressure = p;

        this.inputArr = [
            {
                x,
                y,
                pressure: p,
            },
        ];
    }

    goLine(x: number, y: number, p: number): void {
        if (!this.inputIsDrawing) {
            return;
        }

        const pressure = BB.clamp(p, 0, 1);
        const localSize = this.settingHasSizePressure
            ? Math.max(0.1, this.lastInput.pressure * this.settingSize)
            : Math.max(0.1, this.settingSize);

        this.context.save();
        this.selectionPath && this.context.clip(this.selectionPath);
        this.continueLine(x, y, localSize, this.lastInput.pressure);
        this.context.restore();

        this.lastInput.x = x;
        this.lastInput.y = y;
        this.lastInput2.pressure = this.lastInput.pressure;
        this.lastInput.pressure = pressure;

        this.inputArr.push({
            x,
            y,
            pressure: p,
        });
    }

    endLine(): void {
        const currentInputs = this.inputArr.map((item) => ({ ...item }));
        const currentSettings = this.captureReplaySettings();
        const currentSelectionPath = this.selectionPath;
        const currentSelectionBounds = this.selectionBounds
            ? { ...this.selectionBounds }
            : undefined;
        const originalCurrentBeforeTiles = new Map(this.strokeStartTiles);

        // Finish the normal raster stroke first. Smart correction then rewrites
        // a bounded set of touched tiles and commits the final pixels once.
        let localSize = this.settingHasSizePressure
            ? Math.max(0.1, this.lastInput.pressure * this.settingSize)
            : Math.max(0.1, this.settingSize);
        this.context.save();
        this.selectionPath && this.context.clip(this.selectionPath);
        this.continueLine(null, null, localSize, this.lastInput.pressure);
        this.context.restore();
        this.inputIsDrawing = false;

        if (this.settingAlphaId === ALPHA_SQUARE && !this.hasDrawnDot) {
            let maxInput = this.inputArr[0];
            this.inputArr.forEach((item) => {
                if (item.pressure > maxInput.pressure) {
                    maxInput = item;
                }
            });
            this.context.save();
            this.selectionPath && this.context.clip(this.selectionPath);
            const pressure = BB.clamp(maxInput.pressure, 0, 1);
            localSize = this.settingHasSizePressure
                ? Math.max(0.1, pressure * this.settingSize)
                : Math.max(0.1, this.settingSize);
            this.drawDot(
                maxInput.x,
                maxInput.y,
                localSize,
                this.calcOpacity(pressure),
                this.calcScatter(pressure),
                0,
            );
            this.context.restore();
        }
        this.bezierLine = null;

        let committedInputs = currentInputs;
        let editableBeforeTiles = originalCurrentBeforeTiles;
        const renderedStroke = this.createRenderedSmartStroke(
            currentInputs,
            currentSettings.size,
        );
        if (
            renderedStroke &&
            SmartStrokeSettings.getMode() !== 'off' &&
            currentSettings.alphaId === ALPHA_CIRCLE &&
            currentSettings.scatter === 0 &&
            originalCurrentBeforeTiles.size > 0
        ) {
            const decision = this.getSmartTrimDecision(renderedStroke);
            if (decision?.target === 'previous') {
                const correctedBefore = this.applyPreviousSmartTrim({
                    currentInputs,
                    currentBeforeTiles: originalCurrentBeforeTiles,
                    currentSettings,
                    currentSelectionPath,
                    currentSelectionBounds,
                    intersection: decision.intersection,
                });
                if (correctedBefore) {
                    editableBeforeTiles = correctedBefore;
                }
            } else if (decision?.target === 'current') {
                const trimmed = this.applyCurrentSmartTrim({
                    inputs: currentInputs,
                    beforeTiles: originalCurrentBeforeTiles,
                    settings: currentSettings,
                    selectionPath: currentSelectionPath,
                    selectionBounds: currentSelectionBounds,
                    intersection: decision.intersection,
                });
                if (trimmed) {
                    committedInputs = trimmed;
                }
            }
        }

        if (this.changedTiles.some((item) => item)) {
            this.klHistory.push(
                getPushableLayerChange(
                    this.klHistory.getComposed(),
                    canvasAndChangedTilesToLayerTiles(this.context.canvas, this.changedTiles),
                ),
            );
        }

        const committedStroke = this.createRenderedSmartStroke(
            committedInputs,
            currentSettings.size,
        );
        this.rememberRenderedStroke(committedStroke);
        this.lastBrushHistoryChangeCount = this.klHistory.getChangeCount();
        if (
            committedStroke &&
            SmartStrokeSettings.getMode() !== 'off' &&
            currentSettings.alphaId === ALPHA_CIRCLE &&
            currentSettings.scatter === 0 &&
            editableBeforeTiles.size > 0
        ) {
            this.lastEditableStroke = {
                stroke: committedStroke,
                inputs: committedInputs.map((item) => ({ ...item })),
                beforeTiles: editableBeforeTiles,
                settings: currentSettings,
                selectionPath: currentSelectionPath,
                selectionBounds: currentSelectionBounds,
                historyChangeCount: this.klHistory.getChangeCount(),
            };
        } else {
            this.lastEditableStroke = undefined;
        }

        this.hasDrawnDot = false;
        this.inputArr = [];
        this.strokeStartTiles.clear();
        this.isCapturingStrokeStartTiles = false;
    }

    drawLineSegment(x1: number, y1: number, x2: number, y2: number): void {
        this.selection = this.klHistory.getComposed().selection.value;
        this.selectionPath = this.selection ? getSelectionPath2d(this.selection) : undefined;
        this.selectionBounds = this.selection
            ? getMultiPolyBounds(this.selection, 'index')
            : undefined;
        this.changedTiles = [];
        this.strokeStartTiles.clear();
        this.isCapturingStrokeStartTiles = false;
        this.lastInput.x = x2;
        this.lastInput.y = y2;
        this.lastInput.pressure = 1;

        if (this.inputIsDrawing || x1 === undefined) {
            return;
        }

        const angle = BB.pointsToAngleDeg({ x: x1, y: y1 }, { x: x2, y: y2 });
        const mouseDist = Math.sqrt(Math.pow(x2 - x1, 2.0) + Math.pow(y2 - y1, 2.0));
        const eX = (x2 - x1) / mouseDist;
        const eY = (y2 - y1) / mouseDist;
        let loopDist;
        const bdist = this.settingSize * this.settingSpacing;
        this.lineToolLastDot = this.settingSize * this.settingSpacing;
        this.context.save();
        this.selectionPath && this.context.clip(this.selectionPath);
        const localScatter = this.calcScatter(1);
        for (loopDist = this.lineToolLastDot; loopDist <= mouseDist; loopDist += bdist) {
            this.drawDot(
                x1 + eX * loopDist,
                y1 + eY * loopDist,
                this.settingSize,
                this.settingOpacity,
                localScatter,
                angle,
            );
        }
        this.context.restore();

        if (this.changedTiles.some((item) => item)) {
            this.klHistory.push(
                getPushableLayerChange(
                    this.klHistory.getComposed(),
                    canvasAndChangedTilesToLayerTiles(this.context.canvas, this.changedTiles),
                ),
            );
        }
    }

    //IS
    isDrawing(): boolean {
        return this.inputIsDrawing;
    }

    //SET
    setAlpha(a: number): void {
        if (this.settingAlphaId === a) {
            return;
        }
        this.settingAlphaId = a;
        this.updateAlphaCanvas();
    }

    setColor(c: TRgb): void {
        if (this.settingColor === c) {
            return;
        }
        this.settingColor = { r: c.r, g: c.g, b: c.b };
        this.settingColorStr =
            'rgb(' +
            this.settingColor.r +
            ',' +
            this.settingColor.g +
            ',' +
            this.settingColor.b +
            ')';
        this.updateAlphaCanvas();
    }

    setContext(c: CanvasRenderingContext2D): void {
        if (this.context.canvas && this.context.canvas !== c.canvas) {
            this.recentRenderedStrokes = [];
            this.lastEditableStroke = undefined;
            this.lastBrushHistoryChangeCount = undefined;
        }
        this.context = c;
    }

    setHistory(klHistory: KlHistory): void {
        this.klHistory = klHistory;
    }

    setSize(s: number): void {
        this.settingSize = s;
    }

    setOpacity(o: number): void {
        this.settingOpacity = o;
    }

    setScatter(o: number): void {
        this.settingScatter = o;
    }

    setSpacing(s: number): void {
        this.settingSpacing = s;
    }

    sizePressure(b: boolean): void {
        this.settingHasSizePressure = b;
    }

    opacityPressure(b: boolean): void {
        this.settingHasOpacityPressure = b;
    }

    scatterPressure(b: boolean): void {
        this.settingHasScatterPressure = b;
    }

    setLockAlpha(b: boolean): void {
        this.settingLockLayerAlpha = b;
    }

    //GET
    getSpacing(): number {
        return this.settingSpacing;
    }

    getSize(): number {
        return this.settingSize;
    }

    getOpacity(): number {
        return this.settingOpacity;
    }

    getScatter(): number {
        return this.settingScatter;
    }

    getLockAlpha(): boolean {
        return this.settingLockLayerAlpha;
    }
}
