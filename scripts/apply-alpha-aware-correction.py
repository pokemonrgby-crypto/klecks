from pathlib import Path


def replace_once(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    if old not in text:
        raise SystemExit(f'pattern not found in {path}: {old[:120]!r}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')

# 1) Preserve actual line alpha instead of collapsing it to binary 0/1.
path = 'src/app/script/klecks/image-operations/color-spill-cleanup.ts'
replace_once(
    path,
    """                        expanded[ny * width + nx] = 1;""",
    """                        const neighborIndex = ny * width + nx;
                        expanded[neighborIndex] = Math.max(
                            expanded[neighborIndex],
                            barrier[index],
                        );""",
)
replace_once(
    path,
    """        if (lineData[i * 4 + 3] >= 10) {
            barrier[i] = 1;
        }""",
    """        const alpha = lineData[i * 4 + 3];
        if (alpha >= 10) {
            // Keep real antialias / layer-opacity coverage. Non-zero still
            // behaves as a barrier, while the value is reused for edge alpha.
            barrier[i] = alpha;
        }""",
)

# 2) Build a small distance + nearest-line-alpha field inside the decision crop.
replace_once(
    path,
    """    const decisionRadiusSq = decisionRadius * decisionRadius;
    const applyRadiusSq = applyRadius * applyRadius;
    for (let ly = 0; ly < height; ly++) {""",
    """    const decisionRadiusSq = decisionRadius * decisionRadius;
    const applyRadiusSq = applyRadius * applyRadius;
    const lineDistance = new Float32Array(width * height);
    lineDistance.fill(Number.POSITIVE_INFINITY);
    const nearestLineAlpha = new Uint8Array(width * height);
    const distanceQueue = new Int32Array(width * height);
    let distanceHead = 0;
    let distanceTail = 0;

    for (let ly = 0; ly < height; ly++) {""",
)
replace_once(
    path,
    """            const globalIndex = gy * p.canvasWidth + gx;
            if (!p.lineMask[globalIndex]) {
                labels[ly * width + lx] = -1;
            }
        }
    }

    const queue = new Int32Array(width * height);""",
    """            const globalIndex = gy * p.canvasWidth + gx;
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

    const queue = new Int32Array(width * height);""",
)

# 3) Track representative alpha as well as RGB for each inside component.
replace_once(
    path,
    """    const representativeColor = new Map<number, { r: number; g: number; b: number }>();
    insideGroup.forEach((component) => {
        if (component.alphaSum <= 0) {
            return;
        }
        representativeColor.set(component.id, {
            r: Math.round(component.rSum / component.alphaSum),
            g: Math.round(component.gSum / component.alphaSum),
            b: Math.round(component.bSum / component.alphaSum),
        });
    });""",
    """    const representativeColor = new Map<number, { r: number; g: number; b: number }>();
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
    };""",
)

# 4) Replace hard erase / hard 255 fill with alpha-aware correction.
replace_once(
    path,
    """            const alphaIndex = localIndex * 4 + 3;
            const alpha = data[alphaIndex];
            if (regionClass === 'outside') {
                if (alpha === 0) {
                    continue;
                }
                data[alphaIndex] = 0;
            } else {
                // First version fills only genuinely missing pixels. Existing
                // semi-transparent/shaded paint is intentionally preserved.
                if (alpha > 8) {
                    continue;
                }
                const color = representativeColor.get(componentId);
                if (!color) {
                    continue;
                }
                data[localIndex * 4] = color.r;
                data[localIndex * 4 + 1] = color.g;
                data[localIndex * 4 + 2] = color.b;
                data[alphaIndex] = 255;
            }

            changed = true;""",
    """            const alphaIndex = localIndex * 4 + 3;
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

            changed = true;""",
)

# 5) Hide the experimental stroke-correction UI. Keep implementation for now.
path = 'src/app/script/klecks/brushes-ui/pen-brush-ui.ts'
replace_once(
    path,
    """                smartStrokeRow,
                smartStrokeTargetRow,
""",
    """                // Smart-stroke correction is temporarily hidden while the
                // smart color / virtual-barrier workflow is evaluated.
""",
)

# 6) Force the retained experiment off, including users who had a previous
# non-off value saved in localStorage.
path = 'src/app/script/klecks/events/smart-stroke-settings.ts'
replace_once(
    path,
    """const VALID_TARGETS: readonly TSmartStrokeTarget[] = ['current', 'both'];""",
    """const VALID_TARGETS: readonly TSmartStrokeTarget[] = ['current', 'both'];
const SMART_STROKE_EXPERIMENT_ENABLED = false;""",
)
replace_once(
    path,
    """    getMode(): TSmartStrokeMode {
        return mode;
    },""",
    """    getMode(): TSmartStrokeMode {
        return SMART_STROKE_EXPERIMENT_ENABLED ? mode : 'off';
    },""",
)

print('alpha-aware correction patch applied')
