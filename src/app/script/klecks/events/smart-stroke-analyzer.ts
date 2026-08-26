import {
    TSmartStroke,
    TSmartStrokeAnalysis,
    TSmartStrokeConnectSuggestion,
    TSmartStrokeSample,
    TSmartStrokeTrimSuggestion,
} from './smart-stroke.types';

type TPoint = { x: number; y: number };

type TSegmentIntersection = {
    x: number;
    y: number;
    t: number;
    u: number;
};

export type TSmartStrokeAnalyzerOptions = {
    maxTrimDistance?: number;
    maxConnectDistance?: number;
    minConnectDirectionDot?: number;
};

function distance(a: TPoint, b: TPoint): number {
    return Math.hypot(b.x - a.x, b.y - a.y);
}

function dotNormalized(a: TPoint, b: TPoint): number {
    const aLen = Math.hypot(a.x, a.y);
    const bLen = Math.hypot(b.x, b.y);
    if (aLen < 0.0001 || bLen < 0.0001) {
        return -1;
    }
    return (a.x * b.x + a.y * b.y) / (aLen * bLen);
}

function segmentIntersection(
    a: TPoint,
    b: TPoint,
    c: TPoint,
    d: TPoint,
): TSegmentIntersection | undefined {
    const r = { x: b.x - a.x, y: b.y - a.y };
    const s = { x: d.x - c.x, y: d.y - c.y };
    const denominator = r.x * s.y - r.y * s.x;
    if (Math.abs(denominator) < 0.000001) {
        return undefined;
    }

    const cMinusA = { x: c.x - a.x, y: c.y - a.y };
    const t = (cMinusA.x * s.y - cMinusA.y * s.x) / denominator;
    const u = (cMinusA.x * r.y - cMinusA.y * r.x) / denominator;
    if (t < 0 || t > 1 || u < 0 || u > 1) {
        return undefined;
    }

    return {
        x: a.x + r.x * t,
        y: a.y + r.y * t,
        t,
        u,
    };
}

function getTailLength(samples: TSmartStrokeSample[], segmentIndex: number, t: number): number {
    if (segmentIndex < 0 || segmentIndex + 1 >= samples.length) {
        return Number.POSITIVE_INFINITY;
    }

    let result = distance(samples[segmentIndex], samples[segmentIndex + 1]) * (1 - t);
    for (let i = segmentIndex + 1; i < samples.length - 1; i++) {
        result += distance(samples[i], samples[i + 1]);
    }
    return result;
}

function getEndDirection(samples: TSmartStrokeSample[]): TPoint | undefined {
    if (samples.length < 2) {
        return undefined;
    }
    const endIndex = samples.length - 1;
    const startIndex = Math.max(0, endIndex - 4);
    const a = samples[startIndex];
    const b = samples[endIndex];
    const direction = { x: b.x - a.x, y: b.y - a.y };
    if (Math.hypot(direction.x, direction.y) < 0.0001) {
        return undefined;
    }
    return direction;
}

function findTrimSuggestion(
    current: TSmartStroke,
    recentStrokes: readonly TSmartStroke[],
    maxTrimDistance: number,
): TSmartStrokeTrimSuggestion | undefined {
    const currentSamples = current.samples;
    if (currentSamples.length < 3) {
        return undefined;
    }

    let best: TSmartStrokeTrimSuggestion | undefined;

    for (let referenceStrokeIndex = 0; referenceStrokeIndex < recentStrokes.length; referenceStrokeIndex++) {
        const reference = recentStrokes[referenceStrokeIndex];
        if (reference.samples.length < 2) {
            continue;
        }

        for (let i = 1; i < currentSamples.length - 1; i++) {
            for (let j = 0; j < reference.samples.length - 1; j++) {
                const hit = segmentIntersection(
                    currentSamples[i],
                    currentSamples[i + 1],
                    reference.samples[j],
                    reference.samples[j + 1],
                );
                if (!hit) {
                    continue;
                }

                const overshootLength = getTailLength(currentSamples, i, hit.t);
                if (overshootLength <= 0.5 || overshootLength > maxTrimDistance) {
                    continue;
                }

                const confidence = Math.max(0, 1 - overshootLength / maxTrimDistance);
                const candidate: TSmartStrokeTrimSuggestion = {
                    type: 'trim',
                    confidence,
                    segmentIndex: i,
                    segmentT: hit.t,
                    intersection: { x: hit.x, y: hit.y },
                    overshootLength,
                    referenceStrokeIndex,
                };
                if (!best || candidate.confidence > best.confidence) {
                    best = candidate;
                }
            }
        }
    }

    return best;
}

function findConnectSuggestion(
    current: TSmartStroke,
    recentStrokes: readonly TSmartStroke[],
    maxConnectDistance: number,
    minDirectionDot: number,
): TSmartStrokeConnectSuggestion | undefined {
    const samples = current.samples;
    if (samples.length < 2) {
        return undefined;
    }

    const from = samples[samples.length - 1];
    const direction = getEndDirection(samples);
    if (!direction) {
        return undefined;
    }

    let best: TSmartStrokeConnectSuggestion | undefined;

    for (let referenceStrokeIndex = 0; referenceStrokeIndex < recentStrokes.length; referenceStrokeIndex++) {
        const reference = recentStrokes[referenceStrokeIndex];
        if (reference.samples.length === 0) {
            continue;
        }

        const endpoints = [
            { point: reference.samples[0], endpoint: 'start' as const },
            {
                point: reference.samples[reference.samples.length - 1],
                endpoint: 'end' as const,
            },
        ];

        for (const endpoint of endpoints) {
            const gapLength = distance(from, endpoint.point);
            if (gapLength <= 0.5 || gapLength > maxConnectDistance) {
                continue;
            }

            const towardTarget = {
                x: endpoint.point.x - from.x,
                y: endpoint.point.y - from.y,
            };
            const directionDot = dotNormalized(direction, towardTarget);
            if (directionDot < minDirectionDot) {
                continue;
            }

            const distanceScore = 1 - gapLength / maxConnectDistance;
            const directionScore = (directionDot - minDirectionDot) / (1 - minDirectionDot);
            const confidence = Math.max(0, Math.min(1, distanceScore * 0.65 + directionScore * 0.35));
            const candidate: TSmartStrokeConnectSuggestion = {
                type: 'connect',
                confidence,
                from: { x: from.x, y: from.y },
                to: { x: endpoint.point.x, y: endpoint.point.y },
                gapLength,
                referenceStrokeIndex,
                referenceEndpoint: endpoint.endpoint,
            };
            if (!best || candidate.confidence > best.confidence) {
                best = candidate;
            }
        }
    }

    return best;
}

/**
 * Looks only at vector metadata. It does not mutate the raster layer.
 *
 * The first implementation deliberately returns suggestions instead of
 * applying them. This keeps false positives harmless while we collect real
 * drawing examples and tune the thresholds/model later.
 */
export function analyzeSmartStroke(
    current: TSmartStroke,
    recentStrokes: readonly TSmartStroke[],
    options: TSmartStrokeAnalyzerOptions = {},
): TSmartStrokeAnalysis {
    const maxTrimDistance =
        options.maxTrimDistance ?? Math.max(6, Math.min(24, current.brushRadius * 2.5));
    const maxConnectDistance =
        options.maxConnectDistance ?? Math.max(5, Math.min(20, current.brushRadius * 2));
    const minDirectionDot = options.minConnectDirectionDot ?? 0.6;

    const suggestions = [];
    const trim = findTrimSuggestion(current, recentStrokes, maxTrimDistance);
    if (trim) {
        suggestions.push(trim);
    }
    const connect = findConnectSuggestion(
        current,
        recentStrokes,
        maxConnectDistance,
        minDirectionDot,
    );
    if (connect) {
        suggestions.push(connect);
    }

    suggestions.sort((a, b) => b.confidence - a.confidence);
    return { suggestions };
}
