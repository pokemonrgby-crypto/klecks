import { BB } from '../../../bb/bb';
import { KlSlider } from '../components/kl-slider';
import { Select } from '../components/select';
import { Checkbox } from '../components/checkbox';
import { LANG } from '../../../language/language';
import { TFillSampling } from '../../kl-types';
import { KlColorSlider } from '../components/kl-color-slider';
import { css } from '../../../bb/base/base';
import { TColorSpillLineSourceMode } from '../../image-operations/color-spill-cleanup';

/**
 * Paint Bucket tab contents (color slider, opacity slider, etc)
 */
export class FillUi {
    private readonly rootEl: HTMLElement;
    private isVisible: boolean;
    private readonly colorDiv: HTMLElement;
    private readonly colorSlider: KlColorSlider;
    private readonly toleranceSlider: KlSlider;
    private readonly opacitySlider: KlSlider;
    private readonly modeSelect: Select<string>;
    private readonly growSelect: Select<string>;
    private isContiguous: boolean;
    private readonly eraserToggle: Checkbox;

    private isColorCleanup: boolean = false;
    private readonly normalControlsEl: HTMLElement;
    private readonly cleanupControlsEl: HTMLElement;
    private readonly cleanupRadiusSlider: KlSlider;
    private readonly cleanupBarrierGrowSlider: KlSlider;
    private readonly cleanupReferenceSelect: Select<TColorSpillLineSourceMode>;

    // ----------------------------------- public -----------------------------------

    constructor(p: {
        colorSlider: KlColorSlider; // when opening tab, inserts it (snatches it from where else it was)
    }) {
        this.rootEl = BB.el({
            css: {
                margin: 10,
            },
        });
        this.isVisible = true;
        this.colorSlider = p.colorSlider;

        const cleanupToggle = new Checkbox({
            init: false,
            label: '채색 넘침 보정 브러시',
            title: '켜면 페인트통이 연속 보정 브러시로 바뀌고, 선화 바깥쪽 채색만 지웁니다.',
            callback: (b) => {
                this.isColorCleanup = b;
                this.normalControlsEl.style.display = b ? 'none' : 'block';
                this.cleanupControlsEl.style.display = b ? 'block' : 'none';
            },
            name: 'color-spill-cleanup-toggle',
        });
        this.rootEl.append(
            BB.el({
                content: cleanupToggle.getElement(),
            }),
            BB.el({
                content: 'S Pen으로 문지르면 선화 안쪽은 유지하고 바깥으로 삐져나온 채색만 지웁니다.',
                css: { marginTop: 4, fontSize: 12, opacity: 0.75, lineHeight: 1.35 },
            }),
        );

        this.normalControlsEl = BB.el({
            parent: this.rootEl,
            css: { marginTop: 10 },
        });

        this.colorDiv = BB.el({
            parent: this.normalControlsEl,
            css: {
                marginBottom: 10,
            },
        });

        this.opacitySlider = new KlSlider({
            label: LANG('opacity'),
            width: 250,
            height: 30,
            min: 1 / 100,
            max: 1,
            value: 1,
            toValue: (displayValue) => displayValue / 100,
            toDisplayValue: (value) => value * 100,
        });
        this.normalControlsEl.append(this.opacitySlider.getElement());

        this.toleranceSlider = new KlSlider({
            label: LANG('bucket-tolerance'),
            width: 250,
            height: 30,
            min: 0,
            max: 255,
            value: 20 * (255 / 100),
            toValue: (displayValue) => displayValue * (255 / 100),
            toDisplayValue: (value) => value / (255 / 100),
        });
        css(this.toleranceSlider.getElement(), {
            marginTop: 10,
        });
        this.normalControlsEl.append(this.toleranceSlider.getElement());

        const selectRow = BB.el({
            parent: this.normalControlsEl,
            css: {
                display: 'flex',
                marginTop: 10,
            },
        });

        const modeWrapper = BB.el({
            content: LANG('bucket-sample') + '&nbsp;',
            title: LANG('bucket-sample-title'),
            css: {
                fontSize: 15,
            },
        });
        this.modeSelect = new Select({
            optionArr: [
                ['all', LANG('bucket-sample-all')],
                ['current', LANG('bucket-sample-active')],
                ['above', LANG('bucket-sample-above')],
            ],
            initValue: 'all',
            name: 'sampling-mode',
        });
        new BB.PointerListener({
            target: this.modeSelect.getElement(),
            onWheel: (e) => {
                this.modeSelect.setDeltaValue(e.deltaY);
            },
        });
        modeWrapper.append(this.modeSelect.getElement());
        selectRow.append(modeWrapper);

        const growWrapper = BB.el({
            content: LANG('bucket-grow') + '&nbsp;',
            title: LANG('bucket-grow-title'),
            css: {
                fontSize: 15,
                marginLeft: 10,
            },
        });
        this.growSelect = new Select({
            optionArr: [
                ['0', '0'],
                ['1', '1'],
                ['2', '2'],
                ['3', '3'],
                ['4', '4'],
                ['5', '5'],
                ['6', '6'],
                ['7', '7'],
            ],
            initValue: '0',
            name: 'fill-growth',
        });
        new BB.PointerListener({
            target: this.growSelect.getElement(),
            onWheel: (e) => {
                this.growSelect.setDeltaValue(e.deltaY);
            },
        });
        growWrapper.append(this.growSelect.getElement());
        selectRow.append(growWrapper);

        this.isContiguous = true;
        const contiguousToggle = new Checkbox({
            init: true,
            label: LANG('bucket-contiguous'),
            title: LANG('bucket-contiguous-title'),
            callback: (b) => {
                this.isContiguous = b;
            },
            name: 'is-contiguous',
        });

        this.eraserToggle = new Checkbox({
            init: false,
            label: LANG('eraser'),
            name: 'eraser-toggle',
        });

        this.normalControlsEl.append(
            BB.el({
                content: [contiguousToggle.getElement(), this.eraserToggle.getElement()],
                css: {
                    display: 'flex',
                    marginTop: 10,
                    gap: 10,
                },
            }),
        );

        this.cleanupControlsEl = BB.el({
            parent: this.rootEl,
            css: {
                display: 'none',
                marginTop: 12,
            },
        });

        this.cleanupRadiusSlider = new KlSlider({
            label: '보정 브러시 크기',
            width: 250,
            height: 30,
            min: 4,
            max: 256,
            value: 52,
            manualInputRoundDigits: 0,
        });
        this.cleanupControlsEl.append(this.cleanupRadiusSlider.getElement());

        const referenceRow = BB.el({
            parent: this.cleanupControlsEl,
            css: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginTop: 10,
                fontSize: 14,
            },
        });
        referenceRow.append(BB.el({ content: '선화 기준&nbsp;' }));
        this.cleanupReferenceSelect = new Select<TColorSpillLineSourceMode>({
            optionArr: [
                ['nearest-above', '바로 위'],
                ['all-above', '위쪽 모두'],
                ['nearest-below', '바로 아래'],
                ['all-below', '아래쪽 모두'],
            ],
            initValue: 'nearest-above',
            name: 'color-spill-line-source',
            title: '현재 채색 레이어를 기준으로 어떤 보이는 레이어를 선화 경계로 사용할지 선택합니다.',
            css: { minWidth: 112 },
        });
        referenceRow.append(this.cleanupReferenceSelect.getElement());

        this.cleanupBarrierGrowSlider = new KlSlider({
            label: '선 틈 보정',
            width: 250,
            height: 30,
            min: 0,
            max: 4,
            value: 1,
            manualInputRoundDigits: 0,
        });
        css(this.cleanupBarrierGrowSlider.getElement(), { marginTop: 10 });
        this.cleanupControlsEl.append(
            this.cleanupBarrierGrowSlider.getElement(),
            BB.el({
                content: '값을 높이면 분석할 때만 선화를 조금 두껍게 보아 작은 틈으로 바깥 영역이 새는 것을 줄입니다. 실제 선화는 바뀌지 않습니다.',
                css: { marginTop: 4, fontSize: 12, opacity: 0.75, lineHeight: 1.35 },
            }),
        );
    }

    getElement(): HTMLElement {
        return this.rootEl;
    }

    setIsVisible(pIsVisible: boolean): void {
        this.isVisible = pIsVisible;
        this.rootEl.style.display = this.isVisible ? 'block' : 'none';
        if (this.isVisible) {
            this.colorDiv.append(
                this.colorSlider.getElement(),
                this.colorSlider.getOutputElement(),
            );
        }
    }

    /** [0, 1] */
    getTolerance(): number {
        if (Math.round(this.toleranceSlider.getDisplayValue()) === 0) {
            return 0;
        }
        return this.toleranceSlider.getValue();
    }

    getOpacity(): number {
        return this.opacitySlider.getValue();
    }

    getSample(): TFillSampling {
        return this.modeSelect.getValue() as TFillSampling;
    }

    getGrow(): number {
        return parseInt(this.growSelect.getValue(), 10);
    }

    getContiguous(): boolean {
        return this.isContiguous;
    }

    getIsEraser(): boolean {
        return this.eraserToggle.getValue();
    }

    getIsColorCleanup(): boolean {
        return this.isColorCleanup;
    }

    getColorCleanupRadius(): number {
        return Math.max(2, this.cleanupRadiusSlider.getValue() / 2);
    }

    getColorCleanupLineSourceMode(): TColorSpillLineSourceMode {
        return this.cleanupReferenceSelect.getValue();
    }

    getColorCleanupBarrierGrow(): number {
        return Math.max(0, Math.round(this.cleanupBarrierGrowSlider.getValue()));
    }
}
