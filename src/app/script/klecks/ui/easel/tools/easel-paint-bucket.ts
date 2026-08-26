import { BB } from '../../../../bb/bb';
import { TVector2D } from '../../../../bb/bb-types';
import { TPointerEvent } from '../../../../bb/input/event.types';
import fillImg from 'url:/src/app/img/ui/cursor-fill.png';
import { createMatrixFromTransform } from '../../../../bb/transform/create-matrix-from-transform';
import { applyToPoint, inverse } from 'transformation-matrix';
import { TEaselInterface, TEaselTool } from '../easel.types';
import { BrushCursorRound } from './brush-cursor-round';
import { TViewportTransform } from '../../project-viewport/project-viewport';

export type TEaselPaintBucketParams = {
    onFill: (p: TVector2D) => void;
    getIsCleanupMode: () => boolean;
    getCleanupRadius: () => number;
    getCleanupDecisionRadius: () => number;
    onCleanupStart: (p: TVector2D) => boolean;
    onCleanupMove: (p: TVector2D) => void;
    onCleanupEnd: () => void;
};

export class EaselPaintBucket implements TEaselTool {
    private readonly svgEl: SVGElement;
    private readonly onFill: TEaselPaintBucketParams['onFill'];
    private readonly getIsCleanupMode: TEaselPaintBucketParams['getIsCleanupMode'];
    private readonly getCleanupRadius: TEaselPaintBucketParams['getCleanupRadius'];
    private readonly getCleanupDecisionRadius: TEaselPaintBucketParams['getCleanupDecisionRadius'];
    private readonly onCleanupStart: TEaselPaintBucketParams['onCleanupStart'];
    private readonly onCleanupMove: TEaselPaintBucketParams['onCleanupMove'];
    private readonly onCleanupEnd: TEaselPaintBucketParams['onCleanupEnd'];
    private readonly cleanupCursor = new BrushCursorRound();
    private readonly decisionCursor = new BrushCursorRound();
    private easel: TEaselInterface = {} as TEaselInterface;
    private isDragging = false;
    private lastViewportPos: TVector2D = { x: 0, y: 0 };
    private isOver = false;

    private updateCursor(transform?: TViewportTransform): void {
        if (!this.getIsCleanupMode()) {
            this.svgEl.setAttribute('opacity', '0');
            this.easel.setCursor("url('" + fillImg + "') 1 12, crosshair");
            return;
        }
        this.easel.setCursor('none');
        if (this.isOver) {
            this.svgEl.setAttribute('opacity', '1');
            const t = transform ?? this.easel.getTransform();
            this.decisionCursor.update(
                t,
                this.lastViewportPos,
                this.getCleanupDecisionRadius(),
            );
            this.cleanupCursor.update(t, this.lastViewportPos, this.getCleanupRadius());
        }
    }

    private endCleanup(): void {
        if (!this.isDragging) {
            return;
        }
        this.isDragging = false;
        this.onCleanupEnd();
    }

    constructor(p: TEaselPaintBucketParams) {
        this.svgEl = BB.createSvg({ elementType: 'g' });
        this.svgEl.setAttribute('opacity', '0');
        this.decisionCursor.getElement().setAttribute('opacity', '0.35');
        this.svgEl.append(this.decisionCursor.getElement(), this.cleanupCursor.getElement());
        this.onFill = p.onFill;
        this.getIsCleanupMode = p.getIsCleanupMode;
        this.getCleanupRadius = p.getCleanupRadius;
        this.getCleanupDecisionRadius = p.getCleanupDecisionRadius;
        this.onCleanupStart = p.onCleanupStart;
        this.onCleanupMove = p.onCleanupMove;
        this.onCleanupEnd = p.onCleanupEnd;
    }

    getSvgElement(): SVGElement {
        return this.svgEl;
    }

    onPointer(e: TPointerEvent): void {
        const vTransform = this.easel.getTransform();
        const m = createMatrixFromTransform(vTransform);
        const p = applyToPoint(inverse(m), { x: e.relX, y: e.relY });
        const canvasPoint = { x: p.x, y: p.y };

        this.lastViewportPos = { x: e.relX, y: e.relY };
        this.isOver = e.type !== 'pointerup';
        this.updateCursor(vTransform);

        if (e.type === 'pointerdown' && e.button === 'left') {
            if (this.getIsCleanupMode()) {
                this.isDragging = this.onCleanupStart(canvasPoint);
            } else {
                this.onFill({
                    x: Math.floor(canvasPoint.x),
                    y: Math.floor(canvasPoint.y),
                });
            }
            return;
        }

        if (e.type === 'pointermove' && this.isDragging) {
            this.onCleanupMove(canvasPoint);
            return;
        }

        if (e.type === 'pointerup') {
            this.endCleanup();
        }
    }

    onPointerLeave(): void {
        this.isOver = false;
        this.svgEl.setAttribute('opacity', '0');
    }

    onBlur(): void {
        this.endCleanup();
    }

    getIsLocked(): boolean {
        return this.isDragging;
    }

    setEaselInterface(easelInterface: TEaselInterface): void {
        this.easel = easelInterface;
    }

    onUpdateTransform(transform: TViewportTransform): void {
        if (this.getIsCleanupMode() && this.isOver) {
            this.decisionCursor.update(
                transform,
                this.lastViewportPos,
                this.getCleanupDecisionRadius(),
            );
            this.cleanupCursor.update(
                transform,
                this.lastViewportPos,
                this.getCleanupRadius(),
            );
        }
    }

    activate(cursorPos?: TVector2D): void {
        this.isDragging = false;
        if (cursorPos) {
            this.lastViewportPos = { ...cursorPos };
            this.isOver = true;
        } else {
            this.isOver = false;
        }
        this.updateCursor();
    }
}
