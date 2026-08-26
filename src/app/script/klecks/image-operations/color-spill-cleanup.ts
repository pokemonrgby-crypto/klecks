import { TIndexBounds } from '../../bb/bb-types';

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
