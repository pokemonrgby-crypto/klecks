import { TPointerStylusData, TPointerType } from '../../bb/input/event.types';

/**
 * One sampled point of a brush stroke in canvas coordinates.
 *
 * This data intentionally lives next to the raster result. The painting layer
 * stays raster-based, while recent vector samples can be used for local,
 * non-destructive stroke analysis and future post-correction.
 */
export type TSmartStrokeSample = TPointerStylusData & {
    x: number;
    y: number;
    pressure: number;
    time: number;
    isCoalesced: boolean;
    pointerId: number;
    pointerType: TPointerType;
};

export type TSmartStroke = {
    samples: TSmartStrokeSample[];
    startedAt: number;
    endedAt: number;
    pointerId: number;
    pointerType: TPointerType;
    brushRadius: number;
};

export type TSmartStrokeTrimSuggestion = {
    type: 'trim';
    confidence: number;
    /** Segment index in the newly drawn stroke. */
    segmentIndex: number;
    /** 0..1 position inside segmentIndex -> segmentIndex + 1. */
    segmentT: number;
    intersection: { x: number; y: number };
    overshootLength: number;
    referenceStrokeIndex: number;
};

/**
 * One crossing between the current stroke and one reference stroke, including
 * how much line remains after the crossing on both strokes.
 */
export type TSmartStrokeTailIntersection = {
    intersection: { x: number; y: number };
    currentSegmentIndex: number;
    currentSegmentT: number;
    currentTailLength: number;
    referenceSegmentIndex: number;
    referenceSegmentT: number;
    referenceTailLength: number;
};

export type TSmartStrokeConnectSuggestion = {
    type: 'connect';
    confidence: number;
    from: { x: number; y: number };
    to: { x: number; y: number };
    gapLength: number;
    referenceStrokeIndex: number;
    referenceEndpoint: 'start' | 'end';
};

export type TSmartStrokeCorrectionSuggestion =
    | TSmartStrokeTrimSuggestion
    | TSmartStrokeConnectSuggestion;

export type TSmartStrokeAnalysis = {
    suggestions: TSmartStrokeCorrectionSuggestion[];
};
