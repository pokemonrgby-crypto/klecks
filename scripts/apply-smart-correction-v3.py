from pathlib import Path
import re


def sub_once(path: str, pattern: str, replacement: str):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    new, count = re.subn(pattern, replacement, text, count=1, flags=re.S)
    if count != 1:
        raise RuntimeError(f'pattern count {count} for {path}: {pattern[:100]}')
    p.write_text(new, encoding='utf-8')


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise RuntimeError(f'pattern missing in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


pen = 'src/app/script/klecks/brushes/pen-brush.ts'
replace_once(
    pen,
    "import { TSmartStroke, TSmartStrokeTrimSuggestion } from '../events/smart-stroke.types';",
    "import {\n    TSmartStroke,\n    TSmartStrokeConnectSuggestion,\n    TSmartStrokeTrimSuggestion,\n} from '../events/smart-stroke.types';",
)
replace_once(
    pen,
    "type TSmartTrimDecision = {\n    target: 'current' | 'previous';\n    intersection: { x: number; y: number };\n};",
    "type TSmartTrimDecision = {\n    target: 'current' | 'both';\n    intersection: { x: number; y: number };\n};",
)

new_analysis = r'''    private getTrimLimits(): { maxDistance: number; minConfidence: number } {
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

    private getConnectLimits(): {
        maxDistance: number;
        minDirectionDot: number;
        minConfidence: number;
    } {
        const mode = SmartStrokeSettings.getMode();
        if (mode === 'weak') {
            return {
                maxDistance: Math.max(6, Math.min(20, this.settingSize * 3)),
                minDirectionDot: 0.78,
                minConfidence: SmartStrokeSettings.getMinConnectConfidence(),
            };
        }
        if (mode === 'normal') {
            return {
                maxDistance: Math.max(10, Math.min(36, this.settingSize * 5)),
                minDirectionDot: 0.55,
                minConfidence: SmartStrokeSettings.getMinConnectConfidence(),
            };
        }
        if (mode === 'strong') {
            return {
                maxDistance: Math.max(16, Math.min(56, this.settingSize * 8)),
                minDirectionDot: 0.3,
                minConfidence: SmartStrokeSettings.getMinConnectConfidence(),
            };
        }
        return {
            maxDistance: 0,
            minDirectionDot: 1,
            minConfidence: Number.POSITIVE_INFINITY,
        };
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

    private getRenderedConnectSuggestion(
        current: TSmartStroke,
    ): TSmartStrokeConnectSuggestion | undefined {
        if (SmartStrokeSettings.getMode() === 'off' || this.recentRenderedStrokes.length === 0) {
            return undefined;
        }
        const limits = this.getConnectLimits();
        const analysis = analyzeSmartStroke(
            current,
            this.recentRenderedStrokes.slice(-16),
            {
                maxTrimDistance: 0,
                maxConnectDistance: limits.maxDistance,
                minConnectDirectionDot: limits.minDirectionDot,
            },
        );
        const suggestion = analysis.suggestions.find((item) => item.type === 'connect');
        return suggestion?.type === 'connect' && suggestion.confidence >= limits.minConfidence
            ? suggestion
            : undefined;
    }

    private getSmartTrimDecision(current: TSmartStroke): TSmartTrimDecision | undefined {
        const currentSuggestion = this.getRenderedTrimSuggestion(current);
        if (SmartStrokeSettings.getTarget() !== 'both' || !this.lastEditableStroke) {
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
        const currentConfidence = Math.max(
            0,
            1 - crossing.currentTailLength / Math.max(1, limits.maxDistance),
        );
        const previousConfidence = Math.max(
            0,
            1 - crossing.referenceTailLength / Math.max(1, limits.maxDistance),
        );
        const currentQualifies =
            crossing.currentTailLength > 0.5 &&
            crossing.currentTailLength <= limits.maxDistance &&
            currentConfidence >= limits.minConfidence;
        const previousQualifies =
            crossing.referenceTailLength > 0.5 &&
            crossing.referenceTailLength <= limits.maxDistance &&
            previousConfidence >= limits.minConfidence;

        // `현재 + 직전 획` means both tails are corrected at the same crossing.
        // It no longer chooses just one of the two strokes.
        if (currentQualifies && previousQualifies) {
            return { target: 'both', intersection: crossing.intersection };
        }

        return currentSuggestion
            ? { target: 'current', intersection: currentSuggestion.intersection }
            : undefined;
    }

    private rememberRenderedStroke'''
sub_once(
    pen,
    r"    private getTrimLimits\(\):.*?    private rememberRenderedStroke",
    new_analysis,
)

helpers = r'''    private createConnectedInputArrFrom(
        inputs: readonly TPressureInput[],
        target: { x: number; y: number },
    ): TPressureInput[] | undefined {
        if (inputs.length < 2) {
            return undefined;
        }
        const last = inputs[inputs.length - 1];
        if (Math.hypot(target.x - last.x, target.y - last.y) <= 0.5) {
            return undefined;
        }
        const result = inputs.map((item) => ({ ...item }));
        result.push({ x: target.x, y: target.y, pressure: last.pressure });
        return result;
    }

    private expandBeforeTilesForConnection(
        base: Map<number, ImageData>,
        from: { x: number; y: number },
        to: { x: number; y: number },
        brushSize: number,
    ): Map<number, ImageData> {
        const result = new Map(base);
        const padding = Math.max(2, brushSize * 2);
        const flags = getChangedTiles(
            {
                type: 'index',
                x1: Math.floor(Math.min(from.x, to.x) - padding),
                y1: Math.floor(Math.min(from.y, to.y) - padding),
                x2: Math.ceil(Math.max(from.x, to.x) + padding),
                y2: Math.ceil(Math.max(from.y, to.y) + padding),
            },
            this.context.canvas.width,
            this.context.canvas.height,
        );
        const canvas = this.context.canvas;
        const tilesX = Math.ceil(canvas.width / HISTORY_TILE_SIZE);
        flags.forEach((isChanged, index) => {
            if (!isChanged || result.has(index)) {
                return;
            }
            const col = index % tilesX;
            const row = Math.floor(index / tilesX);
            result.set(index, getTileFromCanvas(canvas, col, row));
        });
        return result;
    }

    private replayStrokeRaster'''
replace_once(pen, "    private replayStrokeRaster", helpers)

apply_block = r'''    private applyCurrentSmartTrim(p: {
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

    private applyBothSmartTrim(p: {
        currentInputs: readonly TPressureInput[];
        currentBeforeTiles: Map<number, ImageData>;
        currentSettings: TPenReplaySettings;
        currentSelectionPath?: Path2D;
        currentSelectionBounds?: TIndexBounds;
        intersection: { x: number; y: number };
    }):
        | {
              currentInputs: TPressureInput[];
              currentBeforeTiles: Map<number, ImageData>;
          }
        | undefined {
        const previous = this.lastEditableStroke;
        if (!previous || previous.beforeTiles.size === 0 || p.currentBeforeTiles.size === 0) {
            return undefined;
        }
        const trimmedPrevious = this.createTrimmedInputArrFrom(
            previous.inputs,
            p.intersection,
            previous.settings.size,
        );
        const trimmedCurrent = this.createTrimmedInputArrFrom(
            p.currentInputs,
            p.intersection,
            p.currentSettings.size,
        );
        if (!trimmedPrevious || !trimmedCurrent) {
            return undefined;
        }

        // Roll both strokes back, then replay both only up to the shared crossing.
        this.restoreTileMap(p.currentBeforeTiles);
        this.restoreTileMap(previous.beforeTiles);
        this.replayStrokeRaster({
            inputs: trimmedPrevious,
            settings: previous.settings,
            selectionPath: previous.selectionPath,
            selectionBounds: previous.selectionBounds,
        });

        const correctedCurrentBefore = this.snapshotTileIndices(p.currentBeforeTiles.keys());
        this.replayStrokeRaster({
            inputs: trimmedCurrent,
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
        return {
            currentInputs: trimmedCurrent,
            currentBeforeTiles: correctedCurrentBefore,
        };
    }

    private applyCurrentSmartConnect(p: {
        inputs: readonly TPressureInput[];
        beforeTiles: Map<number, ImageData>;
        settings: TPenReplaySettings;
        selectionPath?: Path2D;
        selectionBounds?: TIndexBounds;
        target: { x: number; y: number };
    }):
        | {
              inputs: TPressureInput[];
              beforeTiles: Map<number, ImageData>;
          }
        | undefined {
        const connected = this.createConnectedInputArrFrom(p.inputs, p.target);
        if (!connected || p.beforeTiles.size === 0) {
            return undefined;
        }
        const last = p.inputs[p.inputs.length - 1];
        const expandedBefore = this.expandBeforeTilesForConnection(
            p.beforeTiles,
            last,
            p.target,
            p.settings.size,
        );
        this.restoreTileMap(expandedBefore);
        this.replayStrokeRaster({
            inputs: connected,
            settings: p.settings,
            selectionPath: p.selectionPath,
            selectionBounds: p.selectionBounds,
        });
        this.changedTiles = this.changedTilesFromMaps(expandedBefore);
        return { inputs: connected, beforeTiles: expandedBefore };
    }

    private invalidateSmartHistoryIfNeeded'''
sub_once(
    pen,
    r"    private applyCurrentSmartTrim\(p: \{.*?    private invalidateSmartHistoryIfNeeded",
    apply_block,
)

new_end = r'''    endLine(): void {
        const currentInputs = this.inputArr.map((item) => ({ ...item }));
        const currentSettings = this.captureReplaySettings();
        const currentSelectionPath = this.selectionPath;
        const currentSelectionBounds = this.selectionBounds
            ? { ...this.selectionBounds }
            : undefined;
        const originalCurrentBeforeTiles = new Map(this.strokeStartTiles);

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
        let didTrim = false;
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
            if (decision?.target === 'both') {
                const corrected = this.applyBothSmartTrim({
                    currentInputs,
                    currentBeforeTiles: originalCurrentBeforeTiles,
                    currentSettings,
                    currentSelectionPath,
                    currentSelectionBounds,
                    intersection: decision.intersection,
                });
                if (corrected) {
                    committedInputs = corrected.currentInputs;
                    editableBeforeTiles = corrected.currentBeforeTiles;
                    didTrim = true;
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
                    didTrim = true;
                }
            }

            // A trim has priority over connect. If nothing crossed, a confident
            // near-endpoint suggestion now extends the current stroke for real.
            if (!didTrim) {
                const connectSource = this.createRenderedSmartStroke(
                    committedInputs,
                    currentSettings.size,
                );
                const connectSuggestion = connectSource
                    ? this.getRenderedConnectSuggestion(connectSource)
                    : undefined;
                if (connectSuggestion) {
                    const connected = this.applyCurrentSmartConnect({
                        inputs: committedInputs,
                        beforeTiles: editableBeforeTiles,
                        settings: currentSettings,
                        selectionPath: currentSelectionPath,
                        selectionBounds: currentSelectionBounds,
                        target: connectSuggestion.to,
                    });
                    if (connected) {
                        committedInputs = connected.inputs;
                        editableBeforeTiles = connected.beforeTiles;
                    }
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
sub_once(pen, r"    endLine\(\): void \{.*?    drawLineSegment", new_end)

# ---------------------------------------------------------------------------
# KlCanvas: local N-region smart color correction.
# ---------------------------------------------------------------------------
canvas = 'src/app/script/klecks/canvas/kl-canvas.ts'
replace_once(
    canvas,
    "import {\n    createColorSpillOutsideMask,\n    eraseOutsideColorWithBrush,\n    TColorSpillLineSourceMode,\n} from '../image-operations/color-spill-cleanup';",
    "import {\n    correctColorLocallyWithBrush,\n    createColorCorrectionLineMask,\n    TColorSpillLineSourceMode,\n} from '../image-operations/color-spill-cleanup';",
)
replace_once(
    canvas,
    "type TColorSpillCleanupSession = {\n    targetLayerId: TLayerId;\n    targetLayerIndex: number;\n    outsideMask: Uint8Array;\n    selectionMask?: Uint8Array;\n    changedBounds?: TIndexBounds;\n    lastPoint?: { x: number; y: number };\n};",
    "type TColorSpillCleanupSession = {\n    targetLayerId: TLayerId;\n    targetLayerIndex: number;\n    lineMask: Uint8Array;\n    selectionMask?: Uint8Array;\n    changedBounds?: TIndexBounds;\n    lastPoint?: { x: number; y: number };\n    ambiguousSampleCount: number;\n};",
)

new_cleanup = r'''    beginColorSpillCleanup(
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

        const lineMask = createColorCorrectionLineMask({
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
            lineMask,
            selectionMask: this.selection
                ? getBinaryMask(this.selection, this.width, this.height)
                : undefined,
            ambiguousSampleCount: 0,
        };
        return true;
    }

    applyColorSpillCleanup(
        x: number,
        y: number,
        applyRadius: number,
        decisionRadius: number,
    ): { didChange: boolean; needsAi: boolean } {
        const session = this.colorSpillCleanupSession;
        if (!session) {
            return { didChange: false, needsAi: false };
        }
        const targetLayer = this.layers[session.targetLayerIndex];
        if (!targetLayer || targetLayer.id !== session.targetLayerId) {
            this.colorSpillCleanupSession = undefined;
            return { didChange: false, needsAi: false };
        }

        const start = session.lastPoint ?? { x, y };
        const distance = Math.hypot(x - start.x, y - start.y);
        const step = Math.max(1, applyRadius * 0.35);
        const sampleCount = Math.max(1, Math.ceil(distance / step));
        let didChange = false;
        let needsAi = false;

        for (let i = 1; i <= sampleCount; i++) {
            const t = sampleCount === 1 ? 1 : i / sampleCount;
            const sampleX = start.x + (x - start.x) * t;
            const sampleY = start.y + (y - start.y) * t;
            const result = correctColorLocallyWithBrush({
                targetContext: targetLayer.context,
                lineMask: session.lineMask,
                canvasWidth: this.width,
                canvasHeight: this.height,
                x: sampleX,
                y: sampleY,
                decisionRadius,
                applyRadius,
                selectionMask: session.selectionMask,
            });
            if (result.needsAi) {
                needsAi = true;
                session.ambiguousSampleCount++;
            }
            if (!result.didChange || !result.bounds) {
                continue;
            }
            didChange = true;
            const bounds = result.bounds;
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
        return { didChange, needsAi };
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

    floodFill'''
sub_once(
    canvas,
    r"    beginColorSpillCleanup\(.*?    floodFill",
    new_cleanup,
)

# ---------------------------------------------------------------------------
# App wiring: pass both radii; ambiguity is intentionally a no-op until model.
# ---------------------------------------------------------------------------
app = 'src/app/script/app/kl-app.ts'
replace_once(
    app,
    "                    getCleanupRadius: () => fillUi.getColorCleanupRadius(),\n",
    "                    getCleanupRadius: () => fillUi.getColorCleanupRadius(),\n                    getCleanupDecisionRadius: () =>\n                        fillUi.getColorCleanupDecisionRadius(),\n",
)
replace_once(
    app,
    "                            this.klCanvas.applyColorSpillCleanup(\n                                p.x,\n                                p.y,\n                                fillUi.getColorCleanupRadius(),\n                            )\n",
    "                            this.klCanvas.applyColorSpillCleanup(\n                                p.x,\n                                p.y,\n                                fillUi.getColorCleanupRadius(),\n                                fillUi.getColorCleanupDecisionRadius(),\n                            ).didChange\n",
)
replace_once(
    app,
    "                            this.klCanvas.applyColorSpillCleanup(\n                                p.x,\n                                p.y,\n                                fillUi.getColorCleanupRadius(),\n                            )\n",
    "                            this.klCanvas.applyColorSpillCleanup(\n                                p.x,\n                                p.y,\n                                fillUi.getColorCleanupRadius(),\n                                fillUi.getColorCleanupDecisionRadius(),\n                            ).didChange\n",
)

print('smart correction v3 patch applied')
