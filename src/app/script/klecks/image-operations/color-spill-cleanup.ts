import { BB } from '../../bb/bb';
import { TIndexBounds } from '../../bb/bb-types';

export type TColorSpillLineSource = {
    context: CanvasRenderingContext2D;
    opacity: number;
};

export type TColorSpillLineSourceMode =
    | 'nearest-above'
    | 'all-above'
    | 'nearest-below'
    | 'all-below';

export type TLocalColorCorrectionReason =
    | 'resolved'
    | 'single-region'
    | 'regions-too-similar'
    | 'insufficient-color-context';

export type TLocalColorCorrectionResult = {
    didChange: boolean;
    bounds?: TIndexBounds;
    needsAi: boolean;
    reason: TLocalColorCorrectionReason;
    componentCount: number;
    confidence: number;
};

type TComponentStats = {
    id: number;
    area: number;
    applyArea: number;
    coloredCount: number;
    alphaSum: number;
    rSum: number;
    gSum: number;
    bSum: number;
    fillRatio: number;
};

function growBarrier(
    source: Uint8Array,
    width: number,
    height: number,
    growPx: number,
): Uint8Array {
    let barrier = source;
    const passCount = Math.max(0, Math.min(4, Math.round(growPx)));
    for (let pass = 0; pass < passCount; pass++) {
        const expanded = barrier.slice();
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = y * width + x;
                if (!barrier[index]) {
                    continue;
                }
                const x0 = Math.max(0, x - 1);
                const x1 = Math.min(width - 1, x + 1);
                const y0 = Math.max(0, y - 1);
                const y1 = Math.min(height - 1, y + 1);
                for (let ny = y0; ny <= y1; ny++) {
                    for (let nx = x0; nx <= x1; nx++) {
                        const neighborIndex = ny * width + nx;
                        expanded[neighborIndex] = Math.max(
                            expanded[neighborIndex],
                            barrier[index],
                        );
                    }
                }
            }
        }
        barrier = expanded;
    }
    return barrier;
}

/**
 * Builds one full-canvas line-art barrier mask at the beginning of a correction
 * stroke. 1 means the local region analyzer may not cross that pixel.
 */
export function createColorCorrectionLineMask(p: {
    lineSources: readonly TColorSpillLineSource[];
    canvasWidth: number;
    canvasHeight: number;
    barrierGrowPx?: number;
}): Uint8Array {
    const width = p.canvasWidth;
    const height = p.canvasHeight;
    const lineCanvas = BB.canvas(width, height);
    const lineCtx = BB.ctx(lineCanvas);

    for (const source of p.lineSources) {
        if (source.opacity <= 0) {
            continue;
        }
        lineCtx.save();
        lineCtx.globalAlpha = Math.max(0, Math.min(1, source.opacity));
        lineCtx.drawImage(source.context.canvas, 0, 0);
        lineCtx.restore();
    }

    const lineData = lineCtx.getImageData(0, 0, width, height).data;
    let barrier = new Uint8Array(width * height);
    for (let i = 0; i < barrier.length; i++) {
        const alpha = lineData[i * 4 + 3];
        if (alpha >= 10) {
            // Keep real antialias / layer-opacity coverage. Non-zero still
            // behaves as a barrier, while the value is reused for edge alpha.
            barrier[i] = alpha;
        }
    }
    BB.freeCanvas(lineCanvas);
    barrier = growBarrier(barrier, width, height, p.barrierGrowPx ?? 0);
    return barrier;
}

function getLargestRatioGap(components: TComponentStats[]): {
    gap: number;
    splitIndex: number;
} {
    let bestGap = -1;
    let splitIndex = -1;
    for (let i = 0; i < components.length - 1; i++) {
        const gap = components[i + 1].fillRatio - components[i].fillRatio;
        if (gap > bestGap) {
            bestGap = gap;
            splitIndex = i;
        }
    }
    return { gap: Math.max(0, bestGap), splitIndex };
}

/**
 * Local smart color correction.
 *
 * The larger decision circle is split by line-art barriers into N connected
 * regions. Each region is scored by how much of it is already colored on the
 * target layer. Regions with clearly high coverage are treated as "inside";
 * clearly low-coverage regions are treated as "outside". Only the smaller
 * apply circle is modified.
 *
 * If the line art is open and therefore does not separate the circle, or the
 * coverage groups are too similar, the function returns needsAi=true and does
 * not touch pixels. That is the intended future model-fallback trigger.
 */
export function correctColorLocallyWithBrush(p: {
    targetContext: CanvasRenderingContext2D;
    lineMask: Uint8Array;
    canvasWidth: number;
    canvasHeight: number;
    x: number;
    y: number;
    decisionRadius: number;
    applyRadius: number;
    selectionMask?: Uint8Array;
}): TLocalColorCorrectionResult {
    const decisionRadius = Math.max(4, p.decisionRadius);
    const applyRadius = Math.max(1, Math.min(p.applyRadius, decisionRadius * 0.8));
    const x1 = Math.max(0, Math.floor(p.x - decisionRadius));
    const y1 = Math.max(0, Math.floor(p.y - decisionRadius));
    const x2 = Math.min(p.canvasWidth - 1, Math.ceil(p.x + decisionRadius));
    const y2 = Math.min(p.canvasHeight - 1, Math.ceil(p.y + decisionRadius));
    const width = x2 - x1 + 1;
    const height = y2 - y1 + 1;

    if (width <= 0 || height <= 0) {
        return {
            didChange: false,
            needsAi: false,
            reason: 'insufficient-color-context',
            componentCount: 0,
            confidence: 0,
        };
    }

    const image = p.targetContext.getImageData(x1, y1, width, height);
    const data = image.data;
    const labels = new Int32Array(width * height);
    labels.fill(-2); // -2: outside decision circle / barrier, -1: unvisited region

    const decisionRadiusSq = decisionRadius * decisionRadius;
    const applyRadiusSq = applyRadius * applyRadius;
    const lineDistance = new Float32Array(width * height);
    lineDistance.fill(Number.POSITIVE_INFINITY);
    const nearestLineAlpha = new Uint8Array(width * height);
    const distanceQueue = new Int32Array(width * height);
    let distanceHead = 0;
    let distanceTail = 0;

    for (let ly = 0; ly < height; ly++) {
        const gy = y1 + ly;
        const dy = gy + 0.5 - p.y;
        for (let lx = 0; lx < width; lx++) {
            const gx = x1 + lx;
            const dx = gx + 0.5 - p.x;
            if (dx * dx + dy * dy > decisionRadiusSq) {
                continue;
            }
            const globalIndex = gy * p.canvasWidth + gx;
            const localIndex = ly * width + lx;
            const lineAlpha = p.lineMask[globalIndex];
            if (!lineAlpha) {
                labels[localIndex] = -1;
            } else {
                lineDistance[localIndex] = 0;
                nearestLineAlpha[localIndex] = lineAlpha;
                distanceQueue[distanceTail++] = localIndex;
            }
        }
    }

    // 4-neighbour distance is sufficient here: this field is only used to
    // soften paint alpha around the inferred boundary, not for geometry.
    while (distanceHead < distanceTail) {
        const index = distanceQueue[distanceHead++];
        const lx = index % width;
        const ly = Math.floor(index / width);
        const nextDistance = lineDistance[index] + 1;
        const coverage = nearestLineAlpha[index];
        const tryRelax = (next: number, nx: number, ny: number) => {
            if (next < 0 || next >= lineDistance.length) {
                return;
            }
            const gx = x1 + nx;
            const gy = y1 + ny;
            const dx = gx + 0.5 - p.x;
            const dy = gy + 0.5 - p.y;
            if (dx * dx + dy * dy > decisionRadiusSq) {
                return;
            }
            if (nextDistance < lineDistance[next]) {
                lineDistance[next] = nextDistance;
                nearestLineAlpha[next] = coverage;
                distanceQueue[distanceTail++] = next;
            } else if (
                nextDistance === lineDistance[next] &&
                coverage > nearestLineAlpha[next]
            ) {
                nearestLineAlpha[next] = coverage;
            }
        };
        if (lx > 0) tryRelax(index - 1, lx - 1, ly);
        if (lx + 1 < width) tryRelax(index + 1, lx + 1, ly);
        if (ly > 0) tryRelax(index - width, lx, ly - 1);
        if (ly + 1 < height) tryRelax(index + width, lx, ly + 1);
    }

    const queue = new Int32Array(width * height);
    const components: TComponentStats[] = [];
    let nextId = 0;

    for (let start = 0; start < labels.length; start++) {
        if (labels[start] !== -1) {
            continue;
        }

        const stats: TComponentStats = {
            id: nextId,
            area: 0,
            applyArea: 0,
            coloredCount: 0,
            alphaSum: 0,
            rSum: 0,
            gSum: 0,
            bSum: 0,
            fillRatio: 0,
        };
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        labels[start] = nextId;

        while (head < tail) {
            const index = queue[head++];
            const lx = index % width;
            const ly = Math.floor(index / width);
            const gx = x1 + lx;
            const gy = y1 + ly;
            const dx = gx + 0.5 - p.x;
            const dy = gy + 0.5 - p.y;
            stats.area++;
            if (dx * dx + dy * dy <= applyRadiusSq) {
                stats.applyArea++;
            }

            const alpha = data[index * 4 + 3];
            if (alpha >= 16) {
                stats.coloredCount++;
                stats.alphaSum += alpha;
                stats.rSum += data[index * 4] * alpha;
                stats.gSum += data[index * 4 + 1] * alpha;
                stats.bSum += data[index * 4 + 2] * alpha;
            }

            const tryVisit = (next: number) => {
                if (next >= 0 && next < labels.length && labels[next] === -1) {
                    labels[next] = nextId;
                    queue[tail++] = next;
                }
            };
            if (lx > 0) {
                tryVisit(index - 1);
            }
            if (lx + 1 < width) {
                tryVisit(index + 1);
            }
            if (ly > 0) {
                tryVisit(index - width);
            }
            if (ly + 1 < height) {
                tryVisit(index + width);
            }
        }

        stats.fillRatio = stats.area > 0 ? stats.coloredCount / stats.area : 0;
        components.push(stats);
        nextId++;
    }

    const minArea = Math.max(12, Math.round(decisionRadius * 0.6));
    const useful = components
        .filter((component) => component.area >= minArea)
        .sort((a, b) => a.fillRatio - b.fillRatio);

    if (useful.length < 2) {
        return {
            didChange: false,
            needsAi: true,
            reason: 'single-region',
            componentCount: useful.length,
            confidence: 0,
        };
    }

    const { gap, splitIndex } = getLargestRatioGap(useful);
    if (splitIndex < 0 || gap < 0.18) {
        return {
            didChange: false,
            needsAi: true,
            reason: 'regions-too-similar',
            componentCount: useful.length,
            confidence: gap,
        };
    }

    const outsideGroup = useful.slice(0, splitIndex + 1);
    const insideGroup = useful.slice(splitIndex + 1);
    const outsideMean =
        outsideGroup.reduce((sum, item) => sum + item.fillRatio, 0) / outsideGroup.length;
    const insideMean =
        insideGroup.reduce((sum, item) => sum + item.fillRatio, 0) / insideGroup.length;

    if (outsideMean > 0.48 || insideMean < 0.52) {
        return {
            didChange: false,
            needsAi: true,
            reason: 'insufficient-color-context',
            componentCount: useful.length,
            confidence: gap,
        };
    }

    const classification = new Map<number, 'inside' | 'outside'>();
    outsideGroup.forEach((component) => classification.set(component.id, 'outside'));
    insideGroup.forEach((component) => classification.set(component.id, 'inside'));

    const representativeColor = new Map<number, { r: number; g: number; b: number }>();
    const representativeAlpha = new Map<number, number>();
    insideGroup.forEach((component) => {
        if (component.alphaSum <= 0 || component.coloredCount <= 0) {
            return;
        }
        representativeColor.set(component.id, {
            r: Math.round(component.rSum / component.alphaSum),
            g: Math.round(component.gSum / component.alphaSum),
            b: Math.round(component.bSum / component.alphaSum),
        });
        // Do not force repaired paint to 255. Match the alpha already used by
        // the surrounding fill so semi-transparent flat colors remain intact.
        representativeAlpha.set(
            component.id,
            Math.max(1, Math.min(255, Math.round(component.alphaSum / component.coloredCount))),
        );
    });

    // Automatic softness: a few pixels for normal brush sizes, capped so a
    // huge decision circle cannot create an enormous translucent halo.
    const edgeSoftness = Math.max(1.5, Math.min(6, applyRadius * 0.12));
    const getBoundaryInfo = (localIndex: number) => {
        const distanceToLine = lineDistance[localIndex];
        if (!Number.isFinite(distanceToLine) || distanceToLine >= edgeSoftness) {
            return { proximity: 0, coverage: 0 };
        }
        const t = Math.max(0, Math.min(1, distanceToLine / edgeSoftness));
        const smoothT = t * t * (3 - 2 * t);
        return {
            proximity: 1 - smoothT,
            coverage: nearestLineAlpha[localIndex] / 255,
        };
    };

    let changed = false;
    let changedX1 = width;
    let changedY1 = height;
    let changedX2 = -1;
    let changedY2 = -1;

    for (let ly = 0; ly < height; ly++) {
        const gy = y1 + ly;
        const dy = gy + 0.5 - p.y;
        for (let lx = 0; lx < width; lx++) {
            const gx = x1 + lx;
            const dx = gx + 0.5 - p.x;
            if (dx * dx + dy * dy > applyRadiusSq) {
                continue;
            }
            const localIndex = ly * width + lx;
            const componentId = labels[localIndex];
            const regionClass = classification.get(componentId);
            if (!regionClass) {
                continue;
            }

            const globalIndex = gy * p.canvasWidth + gx;
            if (p.selectionMask && p.selectionMask[globalIndex] === 0) {
                continue;
            }

            const alphaIndex = localIndex * 4 + 3;
            const alpha = data[alphaIndex];
            const boundary = getBoundaryInfo(localIndex);

            if (regionClass === 'outside') {
                if (alpha === 0) {
                    continue;
                }
                // Deep outside -> transparent. Close to a semi-transparent /
                // antialiased line -> keep a proportional amount of paint so
                // the edge does not become a hard 1-bit cut.
                const keepFactor = Math.max(
                    0,
                    Math.min(1, boundary.coverage * boundary.proximity * 0.92),
                );
                const targetAlpha = Math.round(alpha * keepFactor);
                if (Math.abs(targetAlpha - alpha) <= 1) {
                    continue;
                }
                data[alphaIndex] = targetAlpha;
            } else {
                const color = representativeColor.get(componentId);
                const interiorAlpha = representativeAlpha.get(componentId);
                if (!color || interiorAlpha === undefined) {
                    continue;
                }

                // Move from a softer alpha at the boundary to the component's
                // natural fill alpha deeper inside. Stronger line coverage has
                // a stronger effect; faint AA pixels only soften a little.
                const edgeFactor = Math.max(
                    0.12,
                    1 - boundary.coverage * boundary.proximity * 0.82,
                );
                const targetAlpha = Math.max(1, Math.round(interiorAlpha * edgeFactor));
                if (alpha + 2 >= targetAlpha) {
                    continue;
                }

                const blend = Math.max(0, Math.min(1, (targetAlpha - alpha) / 255));
                const rgbIndex = localIndex * 4;
                data[rgbIndex] = Math.round(BB.mix(data[rgbIndex], color.r, blend));
                data[rgbIndex + 1] = Math.round(BB.mix(data[rgbIndex + 1], color.g, blend));
                data[rgbIndex + 2] = Math.round(BB.mix(data[rgbIndex + 2], color.b, blend));
                data[alphaIndex] = targetAlpha;
            }

            changed = true;
            changedX1 = Math.min(changedX1, lx);
            changedY1 = Math.min(changedY1, ly);
            changedX2 = Math.max(changedX2, lx);
            changedY2 = Math.max(changedY2, ly);
        }
    }

    if (!changed) {
        return {
            didChange: false,
            needsAi: false,
            reason: 'resolved',
            componentCount: useful.length,
            confidence: gap,
        };
    }

    p.targetContext.putImageData(image, x1, y1);
    return {
        didChange: true,
        bounds: {
            type: 'index',
            x1: x1 + changedX1,
            y1: y1 + changedY1,
            x2: x1 + changedX2,
            y2: y1 + changedY2,
        },
        needsAi: false,
        reason: 'resolved',
        componentCount: useful.length,
        confidence: gap,
    };
}
