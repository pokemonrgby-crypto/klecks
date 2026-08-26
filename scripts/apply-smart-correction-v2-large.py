from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise RuntimeError(f'pattern not found in {path}: {old[:160]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


def regex_once(path: str, pattern: str, replacement: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    new_text, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f'regex count {count} in {path}: {pattern[:160]!r}')
    p.write_text(new_text, encoding='utf-8')


# ---------------------------------------------------------------------------
# Pen UI: strength + correction target.
# ---------------------------------------------------------------------------
pen_ui = 'src/app/script/klecks/brushes-ui/pen-brush-ui.ts'
replace_once(
    pen_ui,
    "import {\n    SmartStrokeSettings,\n    TSmartStrokeMode,\n} from '../events/smart-stroke-settings';\n",
    "import {\n    SmartStrokeSettings,\n    TSmartStrokeMode,\n    TSmartStrokeTarget,\n} from '../events/smart-stroke-settings';\n",
)
replace_once(
    pen_ui,
    "        smartStrokeRow.append(smartStrokeSelect.getElement());\n\n        const spacingSpline",
    "        smartStrokeRow.append(smartStrokeSelect.getElement());\n\n"
    "        const smartStrokeTargetSelect = new Select<TSmartStrokeTarget>({\n"
    "            optionArr: [\n"
    "                ['current', '현재 획만'],\n"
    "                ['previous', '직전 획까지'],\n"
    "            ],\n"
    "            initValue: SmartStrokeSettings.getTarget(),\n"
    "            onChange: (target) => SmartStrokeSettings.setTarget(target),\n"
    "            title: '직전 획까지를 선택하면 방금 그은 획과 직전 획의 꼬리를 비교해 더 자연스러운 쪽을 정리합니다.',\n"
    "            name: 'smart-stroke-target',\n"
    "            css: { minWidth: 112 },\n"
    "        });\n"
    "        const smartStrokeTargetRow = BB.el({\n"
    "            tagName: 'label',\n"
    "            content: '보정 대상&nbsp;',\n"
    "            css: {\n"
    "                display: 'flex',\n"
    "                justifyContent: 'space-between',\n"
    "                alignItems: 'center',\n"
    "                marginTop: 8,\n"
    "            },\n"
    "        });\n"
    "        smartStrokeTargetRow.append(smartStrokeTargetSelect.getElement());\n\n"
    "        const spacingSpline",
)
replace_once(
    pen_ui,
    "                smartStrokeRow,\n            );",
    "                smartStrokeRow,\n                smartStrokeTargetRow,\n            );",
)

# ---------------------------------------------------------------------------
# Pen engine: current + immediately previous safe raster reconstruction.
# ---------------------------------------------------------------------------
pen_path = 'src/app/script/klecks/brushes/pen-brush.ts'
replace_once(
    pen_path,
    "import { analyzeSmartStroke } from '../events/smart-stroke-analyzer';\n",
    "import {\n    analyzeSmartStroke,\n    findSmartStrokeTailIntersection,\n} from '../events/smart-stroke-analyzer';\n",
)
replace_once(
    pen_path,
    "const TWO_PI = 2 * Math.PI;\n\nexport class PenBrush",
    r'''const TWO_PI = 2 * Math.PI;

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

export class PenBrush''',
)
replace_once(
    pen_path,
    "    private recentRenderedStrokes: TSmartStroke[] = [];\n",
    "    private recentRenderedStrokes: TSmartStroke[] = [];\n"
    "    private lastEditableStroke: TEditableSmartStroke | undefined;\n"
    "    private lastBrushHistoryChangeCount: number | undefined;\n",
)

smart_block = r'''    private createRenderedSmartStroke(
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

    private updateChangedTiles'''

regex_once(
    pen_path,
    r"    private createRenderedSmartStroke\(.*?    private updateChangedTiles",
    smart_block,
)

# Start each freehand stroke with a history-integrity check.
replace_once(
    pen_path,
    "    startLine(x: number, y: number, p: number): void {\n        this.selection =",
    "    startLine(x: number, y: number, p: number): void {\n"
    "        this.invalidateSmartHistoryIfNeeded();\n"
    "        this.selection =",
)

new_end_line = r'''    endLine(): void {
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

    drawLineSegment'''
regex_once(
    pen_path,
    r"    endLine\(\): void \{.*?    drawLineSegment",
    new_end_line,
)

replace_once(
    pen_path,
    "    setContext(c: CanvasRenderingContext2D): void {\n        this.context = c;\n    }",
    "    setContext(c: CanvasRenderingContext2D): void {\n"
    "        if (this.context !== c) {\n"
    "            this.recentRenderedStrokes = [];\n"
    "            this.lastEditableStroke = undefined;\n"
    "            this.lastBrushHistoryChangeCount = undefined;\n"
    "        }\n"
    "        this.context = c;\n"
    "    }",
)

# ---------------------------------------------------------------------------
# KlCanvas: explicit continuous cleanup session, no negative-grow hack.
# ---------------------------------------------------------------------------
canvas_path = 'src/app/script/klecks/canvas/kl-canvas.ts'
replace_once(
    canvas_path,
    "import { cleanupColorSpill } from '../image-operations/color-spill-cleanup';\n",
    "import {\n"
    "    createColorSpillOutsideMask,\n"
    "    eraseOutsideColorWithBrush,\n"
    "    TColorSpillLineSourceMode,\n"
    "} from '../image-operations/color-spill-cleanup';\n",
)
replace_once(
    canvas_path,
    "export type TLayerComposite = {\n    draw: (ctx: CanvasRenderingContext2D) => void;\n};\n",
    "export type TLayerComposite = {\n"
    "    draw: (ctx: CanvasRenderingContext2D) => void;\n"
    "};\n\n"
    "type TColorSpillCleanupSession = {\n"
    "    targetLayerId: TLayerId;\n"
    "    targetLayerIndex: number;\n"
    "    outsideMask: Uint8Array;\n"
    "    selectionMask?: Uint8Array;\n"
    "    changedBounds?: TIndexBounds;\n"
    "    lastPoint?: { x: number; y: number };\n"
    "};\n",
)
replace_once(
    canvas_path,
    "    private selection: undefined | MultiPolygon = undefined;\n    private readonly klHistory: KlHistory;\n",
    "    private selection: undefined | MultiPolygon = undefined;\n"
    "    private readonly klHistory: KlHistory;\n"
    "    private colorSpillCleanupSession: TColorSpillCleanupSession | undefined;\n",
)

cleanup_methods = r'''    beginColorSpillCleanup(
        layerIndex: number,
        sourceMode: TColorSpillLineSourceMode,
        barrierGrowPx: number,
    ): boolean {
        this.endColorSpillCleanup();
        const targetLayer = this.layers[layerIndex];
        if (!targetLayer) {
            return false;
        }

        const visible = (layer: TKlCanvasLayer) => layer.isVisible && layer.opacity > 0;
        let sourceLayers: TKlCanvasLayer[] = [];
        if (sourceMode === 'nearest-above') {
            for (let i = layerIndex + 1; i < this.layers.length; i++) {
                if (visible(this.layers[i])) {
                    sourceLayers = [this.layers[i]];
                    break;
                }
            }
        } else if (sourceMode === 'all-above') {
            sourceLayers = this.layers.slice(layerIndex + 1).filter(visible);
        } else if (sourceMode === 'nearest-below') {
            for (let i = layerIndex - 1; i >= 0; i--) {
                if (visible(this.layers[i])) {
                    sourceLayers = [this.layers[i]];
                    break;
                }
            }
        } else {
            sourceLayers = this.layers.slice(0, layerIndex).filter(visible);
        }

        if (sourceLayers.length === 0) {
            return false;
        }

        const outsideMask = createColorSpillOutsideMask({
            lineSources: sourceLayers.map((layer) => ({
                context: layer.context,
                opacity: layer.opacity,
            })),
            canvasWidth: this.width,
            canvasHeight: this.height,
            barrierGrowPx,
        });
        this.colorSpillCleanupSession = {
            targetLayerId: targetLayer.id,
            targetLayerIndex: layerIndex,
            outsideMask,
            selectionMask: this.selection
                ? getBinaryMask(this.selection, this.width, this.height)
                : undefined,
        };
        return true;
    }

    applyColorSpillCleanup(x: number, y: number, radius: number): boolean {
        const session = this.colorSpillCleanupSession;
        if (!session) {
            return false;
        }
        const targetLayer = this.layers[session.targetLayerIndex];
        if (!targetLayer || targetLayer.id !== session.targetLayerId) {
            this.colorSpillCleanupSession = undefined;
            return false;
        }

        const start = session.lastPoint ?? { x, y };
        const distance = Math.hypot(x - start.x, y - start.y);
        const step = Math.max(1, radius * 0.35);
        const sampleCount = Math.max(1, Math.ceil(distance / step));
        let didChange = false;

        for (let i = 1; i <= sampleCount; i++) {
            const t = sampleCount === 1 ? 1 : i / sampleCount;
            const sampleX = start.x + (x - start.x) * t;
            const sampleY = start.y + (y - start.y) * t;
            const bounds = eraseOutsideColorWithBrush({
                targetContext: targetLayer.context,
                outsideMask: session.outsideMask,
                canvasWidth: this.width,
                canvasHeight: this.height,
                x: sampleX,
                y: sampleY,
                radius,
                selectionMask: session.selectionMask,
            });
            if (!bounds) {
                continue;
            }
            didChange = true;
            if (!session.changedBounds) {
                session.changedBounds = { ...bounds };
            } else {
                session.changedBounds.x1 = Math.min(session.changedBounds.x1, bounds.x1);
                session.changedBounds.y1 = Math.min(session.changedBounds.y1, bounds.y1);
                session.changedBounds.x2 = Math.max(session.changedBounds.x2, bounds.x2);
                session.changedBounds.y2 = Math.max(session.changedBounds.y2, bounds.y2);
            }
        }
        session.lastPoint = { x, y };
        return didChange;
    }

    endColorSpillCleanup(): void {
        const session = this.colorSpillCleanupSession;
        this.colorSpillCleanupSession = undefined;
        if (!session?.changedBounds || this.klHistory.isPaused()) {
            return;
        }
        const targetLayer = this.layers[session.targetLayerIndex];
        if (!targetLayer || targetLayer.id !== session.targetLayerId) {
            return;
        }
        this.klHistory.push({
            layerMap: createLayerMap(this.layers, {
                layerId: targetLayer.id,
                attributes: ['tiles'],
                bounds: session.changedBounds,
            }),
        });
    }

    floodFill('''
regex_once(
    canvas_path,
    r"    floodFill\(",
    cleanup_methods,
)
regex_once(
    canvas_path,
    r"\n        if \(grow < 0\) \{.*?\n            return;\n        \}\n",
    "\n",
)

# ---------------------------------------------------------------------------
# App wiring: normal fill on tap, cleanup session on drag.
# ---------------------------------------------------------------------------
app_path = 'src/app/script/app/kl-app.ts'
old_bucket = r'''                paintBucket: new EaselPaintBucket({
                    onFill: (p) => {
                        this.klCanvas.floodFill(
                            currentLayer.index,
                            p.x,
                            p.y,
                            fillUi.getIsEraser() ? null : this.klColorSlider.getColor(),
                            fillUi.getOpacity(),
                            fillUi.getTolerance(),
                            fillUi.getSample(),
                            fillUi.getGrow(),
                            fillUi.getContiguous(),
                        );
                        this.easel.requestRender();
                    },
                }),'''
new_bucket = r'''                paintBucket: new EaselPaintBucket({
                    onFill: (p) => {
                        this.klCanvas.floodFill(
                            currentLayer.index,
                            p.x,
                            p.y,
                            fillUi.getIsEraser() ? null : this.klColorSlider.getColor(),
                            fillUi.getOpacity(),
                            fillUi.getTolerance(),
                            fillUi.getSample(),
                            fillUi.getGrow(),
                            fillUi.getContiguous(),
                        );
                        this.easel.requestRender();
                    },
                    getIsCleanupMode: () => fillUi.getIsColorCleanup(),
                    getCleanupRadius: () => fillUi.getColorCleanupRadius(),
                    onCleanupStart: (p) => {
                        const didStart = this.klCanvas.beginColorSpillCleanup(
                            currentLayer.index,
                            fillUi.getColorCleanupLineSourceMode(),
                            fillUi.getColorCleanupBarrierGrow(),
                        );
                        if (!didStart) {
                            this.statusOverlay.out('선화 기준 레이어를 찾지 못했습니다.', true);
                            return false;
                        }
                        if (
                            this.klCanvas.applyColorSpillCleanup(
                                p.x,
                                p.y,
                                fillUi.getColorCleanupRadius(),
                            )
                        ) {
                            this.easel.requestRender();
                        }
                        return true;
                    },
                    onCleanupMove: (p) => {
                        if (
                            this.klCanvas.applyColorSpillCleanup(
                                p.x,
                                p.y,
                                fillUi.getColorCleanupRadius(),
                            )
                        ) {
                            this.easel.requestRender();
                        }
                    },
                    onCleanupEnd: () => {
                        this.klCanvas.endColorSpillCleanup();
                        this.easel.requestRender();
                    },
                }),'''
replace_once(app_path, old_bucket, new_bucket)

print('smart correction v2 large patch applied')
