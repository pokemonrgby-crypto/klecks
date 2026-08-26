from pathlib import Path
import re


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise RuntimeError(f'pattern not found in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


# ------------------------------------------------------------------
# Smart stroke: analyze the actual smoothing-output path in PenBrush.
# ------------------------------------------------------------------
pen_path = 'src/app/script/klecks/brushes/pen-brush.ts'
replace_once(
    pen_path,
    "import { SmartStrokeSettings } from '../events/smart-stroke-settings';\n",
    "import { SmartStrokeSettings } from '../events/smart-stroke-settings';\n"
    "import { analyzeSmartStroke } from '../events/smart-stroke-analyzer';\n"
    "import { TSmartStroke, TSmartStrokeTrimSuggestion } from '../events/smart-stroke.types';\n",
)
replace_once(
    pen_path,
    "    private strokeStartTiles = new Map<number, ImageData>();\n    private isCapturingStrokeStartTiles: boolean = false;\n",
    "    private strokeStartTiles = new Map<number, ImageData>();\n"
    "    private isCapturingStrokeStartTiles: boolean = false;\n"
    "    private recentRenderedStrokes: TSmartStroke[] = [];\n",
)

smart_methods = r'''
    private createRenderedSmartStroke(
        inputs: readonly TPressureInput[],
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
            brushRadius: this.settingSize,
        };
    }

    private getRenderedTrimSuggestion(
        current: TSmartStroke,
    ): TSmartStrokeTrimSuggestion | undefined {
        const mode = SmartStrokeSettings.getMode();
        if (mode === 'off' || this.recentRenderedStrokes.length === 0) {
            return undefined;
        }

        const maxTrimDistance =
            mode === 'weak'
                ? Math.max(8, Math.min(24, this.settingSize * 4))
                : mode === 'normal'
                  ? Math.max(12, Math.min(48, this.settingSize * 8))
                  : Math.max(18, Math.min(72, this.settingSize * 12));
        const minConfidence = mode === 'weak' ? 0.45 : mode === 'normal' ? 0.15 : 0.03;
        const analysis = analyzeSmartStroke(
            current,
            this.recentRenderedStrokes.slice(-16),
            { maxTrimDistance },
        );
        const suggestion = analysis.suggestions.find((item) => item.type === 'trim');
        return suggestion?.type === 'trim' && suggestion.confidence >= minConfidence
            ? suggestion
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

'''
replace_once(
    pen_path,
    "    private createTrimmedInputArr(trimPoint: { x: number; y: number }): TPressureInput[] | undefined {\n",
    smart_methods + "    private createTrimmedInputArr(trimPoint: { x: number; y: number }): TPressureInput[] | undefined {\n",
)
replace_once(
    pen_path,
    "    endLine(): void {\n        const pendingTrim = SmartStrokeSettings.consumePendingTrim();\n        if (pendingTrim) {\n            this.tryApplySmartTrim(pendingTrim.intersection);\n        }\n\n",
    "    endLine(): void {\n"
    "        const renderedStroke = this.createRenderedSmartStroke(this.inputArr);\n"
    "        const trimSuggestion = renderedStroke\n"
    "            ? this.getRenderedTrimSuggestion(renderedStroke)\n"
    "            : undefined;\n"
    "        if (trimSuggestion) {\n"
    "            this.tryApplySmartTrim(trimSuggestion.intersection);\n"
    "        }\n\n",
)
replace_once(
    pen_path,
    "        this.hasDrawnDot = false;\n        this.inputArr = [];\n        this.strokeStartTiles.clear();\n",
    "        this.rememberRenderedStroke(this.createRenderedSmartStroke(this.inputArr));\n\n"
    "        this.hasDrawnDot = false;\n"
    "        this.inputArr = [];\n"
    "        this.strokeStartTiles.clear();\n",
)
replace_once(
    pen_path,
    "    setContext(c: CanvasRenderingContext2D): void {\n        this.context = c;\n    }\n",
    "    setContext(c: CanvasRenderingContext2D): void {\n"
    "        if (this.context.canvas && this.context.canvas !== c.canvas) {\n"
    "            this.recentRenderedStrokes = [];\n"
    "        }\n"
    "        this.context = c;\n"
    "    }\n",
)

# Stop using raw Easel pointer geometry for automatic correction.
easel_path = 'src/app/script/klecks/ui/easel/tools/easel-brush.ts'
p = Path(easel_path)
text = p.read_text(encoding='utf-8')
text = text.replace("import { SmartStrokeSettings } from '../../../events/smart-stroke-settings';\n", '')
new_text, count = re.subn(
    r"\n    private prepareSmartTrim\(\): void \{.*?\n    \}\n\n    private onExplodedPointer",
    "\n    private onExplodedPointer",
    text,
    count=1,
    flags=re.S,
)
if count != 1:
    raise RuntimeError('prepareSmartTrim block not found')
text = new_text
text = text.replace('            SmartStrokeSettings.clearPendingTrim();\n', '')
text = text.replace('        SmartStrokeSettings.clearPendingTrim();\n', '')
text = text.replace(
    '            this.smartStrokeRecorder.end(e.time);\n            this.prepareSmartTrim();\n            this.onLineEnd();',
    '            this.smartStrokeRecorder.end(e.time);\n            this.onLineEnd();',
)
p.write_text(text, encoding='utf-8')

# --------------------------------------------------------------
# Color spill cleanup: paint-bucket mode, local barrier flood.
# --------------------------------------------------------------
cleanup_path = Path('src/app/script/klecks/image-operations/color-spill-cleanup.ts')
cleanup_path.write_text(r'''import { TIndexBounds } from '../../bb/bb-types';

export type TColorSpillLineSource = {
    context: CanvasRenderingContext2D;
    opacity: number;
};

export function cleanupColorSpill(p: {
    targetContext: CanvasRenderingContext2D;
    lineSources: readonly TColorSpillLineSource[];
    canvasWidth: number;
    canvasHeight: number;
    x: number;
    y: number;
    radius: number;
    selectionMask?: Uint8Array;
}): TIndexBounds | undefined {
    const radius = Math.max(8, Math.round(p.radius));
    const x1 = Math.max(0, Math.floor(p.x - radius));
    const y1 = Math.max(0, Math.floor(p.y - radius));
    const x2 = Math.min(p.canvasWidth - 1, Math.ceil(p.x + radius));
    const y2 = Math.min(p.canvasHeight - 1, Math.ceil(p.y + radius));
    const width = x2 - x1 + 1;
    const height = y2 - y1 + 1;
    if (width <= 0 || height <= 0) {
        return undefined;
    }

    const targetImage = p.targetContext.getImageData(x1, y1, width, height);
    const targetData = targetImage.data;
    const seedX = Math.max(0, Math.min(width - 1, Math.round(p.x) - x1));
    const seedY = Math.max(0, Math.min(height - 1, Math.round(p.y) - y1));
    const seedIndex = seedY * width + seedX;
    if (targetData[seedIndex * 4 + 3] === 0) {
        return undefined;
    }

    let barrier = new Uint8Array(width * height);
    for (const source of p.lineSources) {
        const image = source.context.getImageData(x1, y1, width, height).data;
        const opacity = Math.max(0, Math.min(1, source.opacity));
        for (let i = 0; i < barrier.length; i++) {
            if (image[i * 4 + 3] * opacity >= 10) {
                barrier[i] = 1;
            }
        }
    }

    for (let pass = 0; pass < 2; pass++) {
        const expanded = barrier.slice();
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = y * width + x;
                if (!barrier[index]) {
                    continue;
                }
                for (let oy = -1; oy <= 1; oy++) {
                    for (let ox = -1; ox <= 1; ox++) {
                        const nx = x + ox;
                        const ny = y + oy;
                        if (nx >= 0 && ny >= 0 && nx < width && ny < height) {
                            expanded[ny * width + nx] = 1;
                        }
                    }
                }
            }
        }
        barrier = expanded;
    }

    if (p.selectionMask) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const globalIndex = (y1 + y) * p.canvasWidth + (x1 + x);
                if (p.selectionMask[globalIndex] === 0) {
                    barrier[y * width + x] = 1;
                }
            }
        }
    }
    if (barrier[seedIndex]) {
        return undefined;
    }

    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    let queueStart = 0;
    let queueEnd = 0;
    queue[queueEnd++] = seedIndex;
    visited[seedIndex] = 1;
    let touchesBoundary = false;

    while (queueStart < queueEnd) {
        const index = queue[queueStart++];
        const x = index % width;
        const y = Math.floor(index / width);
        if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
            touchesBoundary = true;
        }
        const neighbors = [index - 1, index + 1, index - width, index + width];
        for (let n = 0; n < neighbors.length; n++) {
            if ((n === 0 && x === 0) || (n === 1 && x === width - 1)) {
                continue;
            }
            if ((n === 2 && y === 0) || (n === 3 && y === height - 1)) {
                continue;
            }
            const next = neighbors[n];
            if (visited[next] || barrier[next]) {
                continue;
            }
            visited[next] = 1;
            queue[queueEnd++] = next;
        }
    }

    if (!touchesBoundary) {
        return undefined;
    }

    let changed = 0;
    let changedX1 = width;
    let changedY1 = height;
    let changedX2 = -1;
    let changedY2 = -1;
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const index = y * width + x;
            if (!visited[index] || barrier[index]) {
                continue;
            }
            const alphaIndex = index * 4 + 3;
            if (targetData[alphaIndex] === 0) {
                continue;
            }
            targetData[alphaIndex] = 0;
            changed++;
            changedX1 = Math.min(changedX1, x);
            changedY1 = Math.min(changedY1, y);
            changedX2 = Math.max(changedX2, x);
            changedY2 = Math.max(changedY2, y);
        }
    }
    if (changed === 0) {
        return undefined;
    }

    p.targetContext.putImageData(targetImage, x1, y1);
    return {
        type: 'index',
        x1: x1 + changedX1,
        y1: y1 + changedY1,
        x2: x1 + changedX2,
        y2: y1 + changedY2,
    };
}
''', encoding='utf-8')

fill_ui = 'src/app/script/klecks/ui/tool-tabs/fill-ui.ts'
replace_once(
    fill_ui,
    "    private readonly eraserToggle: Checkbox;\n",
    "    private readonly eraserToggle: Checkbox;\n"
    "    private isColorCleanup: boolean = false;\n"
    "    private readonly cleanupRadiusSlider: KlSlider;\n",
)
replace_once(
    fill_ui,
    "        this.eraserToggle = new Checkbox({\n            init: false,\n            label: LANG('eraser'),\n            name: 'eraser-toggle',\n        });\n\n        this.rootEl.append(\n",
    "        this.eraserToggle = new Checkbox({\n"
    "            init: false,\n"
    "            label: LANG('eraser'),\n"
    "            name: 'eraser-toggle',\n"
    "        });\n\n"
    "        this.cleanupRadiusSlider = new KlSlider({\n"
    "            label: '정리 범위',\n"
    "            width: 250,\n"
    "            height: 30,\n"
    "            min: 16,\n"
    "            max: 256,\n"
    "            value: 96,\n"
    "        });\n"
    "        const cleanupRadiusEl = this.cleanupRadiusSlider.getElement();\n"
    "        cleanupRadiusEl.style.display = 'none';\n"
    "        const cleanupToggle = new Checkbox({\n"
    "            init: false,\n"
    "            label: '채색 넘침 정리',\n"
    "            title: '켜면 페인트통 클릭이 채우기 대신 선화 밖으로 넘친 채색을 정리합니다.',\n"
    "            callback: (b) => {\n"
    "                this.isColorCleanup = b;\n"
    "                cleanupRadiusEl.style.display = b ? '' : 'none';\n"
    "            },\n"
    "            name: 'color-spill-cleanup-toggle',\n"
    "        });\n\n"
    "        this.rootEl.append(\n",
)
replace_once(
    fill_ui,
    "        );\n    }\n\n    getElement(): HTMLElement {\n",
    "        );\n"
    "        this.rootEl.append(\n"
    "            BB.el({\n"
    "                content: cleanupToggle.getElement(),\n"
    "                css: { marginTop: 12 },\n"
    "            }),\n"
    "            BB.el({\n"
    "                content: '현재 채색 레이어 위의 보이는 레이어를 선화 경계로 사용합니다. 넘친 색 부분을 탭하세요.',\n"
    "                css: { marginTop: 4, fontSize: 12, opacity: 0.75, lineHeight: 1.35 },\n"
    "            }),\n"
    "            cleanupRadiusEl,\n"
    "        );\n"
    "    }\n\n"
    "    getElement(): HTMLElement {\n",
)
replace_once(
    fill_ui,
    "    getGrow(): number {\n        return parseInt(this.growSelect.getValue(), 10);\n    }\n",
    "    getGrow(): number {\n"
    "        if (this.isColorCleanup) {\n"
    "            return -Math.max(16, Math.round(this.cleanupRadiusSlider.getValue()));\n"
    "        }\n"
    "        return parseInt(this.growSelect.getValue(), 10);\n"
    "    }\n",
)

kl_canvas = 'src/app/script/klecks/canvas/kl-canvas.ts'
replace_once(
    kl_canvas,
    "import { floodFillBits } from '../image-operations/flood-fill';\n",
    "import { floodFillBits } from '../image-operations/flood-fill';\n"
    "import { cleanupColorSpill } from '../image-operations/color-spill-cleanup';\n",
)
replace_once(
    kl_canvas,
    "        if (selectionMask && selectionMask[y * this.width + x] === 0) {\n            // don't fill if outside of selection\n            return;\n        }\n\n        const targetLayer = this.layers[layerIndex];\n",
    "        if (selectionMask && selectionMask[y * this.width + x] === 0) {\n"
    "            // don't fill if outside of selection\n"
    "            return;\n"
    "        }\n\n"
    "        if (grow < 0) {\n"
    "            const targetLayer = this.layers[layerIndex];\n"
    "            const lineSources = this.layers\n"
    "                .slice(layerIndex + 1)\n"
    "                .filter((layer) => layer.isVisible && layer.opacity > 0)\n"
    "                .map((layer) => ({ context: layer.context, opacity: layer.opacity }));\n"
    "            if (lineSources.length === 0) {\n"
    "                return;\n"
    "            }\n"
    "            const bounds = cleanupColorSpill({\n"
    "                targetContext: targetLayer.context,\n"
    "                lineSources,\n"
    "                canvasWidth: this.width,\n"
    "                canvasHeight: this.height,\n"
    "                x,\n"
    "                y,\n"
    "                radius: Math.max(16, Math.min(256, Math.abs(Math.round(grow)))),\n"
    "                selectionMask,\n"
    "            });\n"
    "            if (bounds && !this.klHistory.isPaused()) {\n"
    "                this.klHistory.push({\n"
    "                    layerMap: createLayerMap(this.layers, {\n"
    "                        layerId: targetLayer.id,\n"
    "                        attributes: ['tiles'],\n"
    "                        bounds,\n"
    "                    }),\n"
    "                });\n"
    "            }\n"
    "            return;\n"
    "        }\n\n"
    "        const targetLayer = this.layers[layerIndex];\n",
)

docs = 'docs/smart-drawing.ko.md'
replace_once(
    docs,
    "- recorder는 Easel 단계의 pointer sample을 사용하고 실제 Pen 렌더 경로는 smoothing 이후 경로이므로, 자동 적용 시 분석 교차점을 렌더 경로에 다시 투영한다. 향후에는 stabilizer/smoothing 이후 경로 자체를 sidecar에 함께 기록하는 쪽이 더 정확하다.\n",
    "- 자동 trim 판정은 실제 Pen 브러시에 전달된 smoothing 이후 입력 경로를 기준으로 한다. Easel의 원시 pointer sidecar는 스타일러스 메타데이터 보관/향후 분석용으로 별도로 유지한다.\n",
)
replace_once(
    docs,
    "### 구현 상태\n\n아직 미구현. 먼저 flood/barrier 기반의 결정론적 알고리즘으로 시도하고, 애매한 가장자리만 작은 segmentation 모델로 처리하는 방향을 우선한다.\n\n## 3. 주변 채색 기반 선화 색 조정\n",
    "### 구현 상태\n\n1차 버전을 구현했다. **페인트통 설정의 `채색 넘침 정리`를 켜면** 일반 채우기 대신 국소 정리 모드가 된다.\n\n"
    "- 현재 채색 레이어보다 위에 있는 보이는 레이어들의 alpha를 임시 선화 barrier로 합친다.\n"
    "- 선화 barrier를 1~2px 정도 임시로 두껍게 만들어 작은 AA/미세 틈을 막는다. 실제 선화 레이어는 수정하지 않는다.\n"
    "- 넘친 채색 부분을 탭하면 지정한 `정리 범위` 안에서 선화 바깥과 연결된 영역만 탐색한다.\n"
    "- 선화로 완전히 둘러싸인 내부 영역은 지우지 않는다.\n"
    "- 선택 영역이 있으면 선택 밖은 정리하지 않는다.\n"
    "- 현재 버전은 **바깥으로 넘친 채색 제거**만 지원한다. 선 안쪽의 덜 채워진 부분 자동 보충은 다음 단계다.\n\n"
    "현재 전제는 투명 배경의 선화 레이어가 채색 레이어 위에 놓여 있는 일반적인 레이어 구조다.\n\n"
    "## 3. 주변 채색 기반 선화 색 조정\n",
)
