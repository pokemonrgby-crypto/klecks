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
                        expanded[ny * width + nx] = 1;
                    }
                }
            }
        }
        barrier = expanded;
    }
    return barrier;
}

/**
 * Builds a mask where 1 means "outside the line art".
 *
 * Visible line-art layers are composited only for analysis. Their pixels are
 * never modified. The outside region is the transparent/non-barrier region
 * connected to the canvas boundary.
 */
export function createColorSpillOutsideMask(p: {
    lineSources: readonly TColorSpillLineSource[];
    canvasWidth: number;
    canvasHeight: number;
    barrierGrowPx?: number;
}): Uint8Array {
    const width = p.canvasWidth;
    const height = p.canvasHeight;
    const len = width * height;
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
    let barrier = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        if (lineData[i * 4 + 3] >= 10) {
            barrier[i] = 1;
        }
    }
    BB.freeCanvas(lineCanvas);

    barrier = growBarrier(barrier, width, height, p.barrierGrowPx ?? 1);

    const outside = new Uint8Array(len);
    const queue = new Int32Array(len);
    let queueStart = 0;
    let queueEnd = 0;

    const enqueue = (index: number) => {
        if (index < 0 || index >= len || barrier[index] || outside[index]) {
            return;
        }
        outside[index] = 1;
        queue[queueEnd++] = index;
    };

    if (width > 0 && height > 0) {
        for (let x = 0; x < width; x++) {
            enqueue(x);
            enqueue((height - 1) * width + x);
        }
        for (let y = 1; y < height - 1; y++) {
            enqueue(y * width);
            enqueue(y * width + (width - 1));
        }
    }

    while (queueStart < queueEnd) {
        const index = queue[queueStart++];
        const x = index % width;
        const y = Math.floor(index / width);
        if (x > 0) {
            enqueue(index - 1);
        }
        if (x + 1 < width) {
            enqueue(index + 1);
        }
        if (y > 0) {
            enqueue(index - width);
        }
        if (y + 1 < height) {
            enqueue(index + width);
        }
    }

    return outside;
}

/**
 * Erases only target-layer pixels that are both under the brush and classified
 * as outside the line-art boundary.
 */
export function eraseOutsideColorWithBrush(p: {
    targetContext: CanvasRenderingContext2D;
    outsideMask: Uint8Array;
    canvasWidth: number;
    canvasHeight: number;
    x: number;
    y: number;
    radius: number;
    selectionMask?: Uint8Array;
}): TIndexBounds | undefined {
    const radius = Math.max(1, p.radius);
    const x1 = Math.max(0, Math.floor(p.x - radius));
    const y1 = Math.max(0, Math.floor(p.y - radius));
    const x2 = Math.min(p.canvasWidth - 1, Math.ceil(p.x + radius));
    const y2 = Math.min(p.canvasHeight - 1, Math.ceil(p.y + radius));
    const width = x2 - x1 + 1;
    const height = y2 - y1 + 1;
    if (width <= 0 || height <= 0) {
        return undefined;
    }

    const image = p.targetContext.getImageData(x1, y1, width, height);
    const data = image.data;
    const radiusSq = radius * radius;
    let changed = false;
    let changedX1 = width;
    let changedY1 = height;
    let changedX2 = -1;
    let changedY2 = -1;

    for (let localY = 0; localY < height; localY++) {
        const globalY = y1 + localY;
        const dy = globalY + 0.5 - p.y;
        for (let localX = 0; localX < width; localX++) {
            const globalX = x1 + localX;
            const dx = globalX + 0.5 - p.x;
            if (dx * dx + dy * dy > radiusSq) {
                continue;
            }

            const globalIndex = globalY * p.canvasWidth + globalX;
            if (!p.outsideMask[globalIndex]) {
                continue;
            }
            if (p.selectionMask && p.selectionMask[globalIndex] === 0) {
                continue;
            }

            const localIndex = localY * width + localX;
            const alphaIndex = localIndex * 4 + 3;
            if (data[alphaIndex] === 0) {
                continue;
            }
            data[alphaIndex] = 0;
            changed = true;
            changedX1 = Math.min(changedX1, localX);
            changedY1 = Math.min(changedY1, localY);
            changedX2 = Math.max(changedX2, localX);
            changedY2 = Math.max(changedY2, localY);
        }
    }

    if (!changed) {
        return undefined;
    }

    p.targetContext.putImageData(image, x1, y1);
    return {
        type: 'index',
        x1: x1 + changedX1,
        y1: y1 + changedY1,
        x2: x1 + changedX2,
        y2: y1 + changedY2,
    };
}
