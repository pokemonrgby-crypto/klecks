from pathlib import Path

path = Path('scripts/apply-smart-correction-v2-large.py')
text = path.read_text(encoding='utf-8')
old = '''replace_once(
    pen_path,
    "    setContext(c: CanvasRenderingContext2D): void {\\n        this.context = c;\\n    }",
    "    setContext(c: CanvasRenderingContext2D): void {\\n"
    "        if (this.context !== c) {\\n"
    "            this.recentRenderedStrokes = [];\\n"
    "            this.lastEditableStroke = undefined;\\n"
    "            this.lastBrushHistoryChangeCount = undefined;\\n"
    "        }\\n"
    "        this.context = c;\\n"
    "    }",
)
'''
new = '''replace_once(
    pen_path,
    "    setContext(c: CanvasRenderingContext2D): void {\\n"
    "        if (this.context.canvas && this.context.canvas !== c.canvas) {\\n"
    "            this.recentRenderedStrokes = [];\\n"
    "        }\\n"
    "        this.context = c;\\n"
    "    }",
    "    setContext(c: CanvasRenderingContext2D): void {\\n"
    "        if (this.context.canvas && this.context.canvas !== c.canvas) {\\n"
    "            this.recentRenderedStrokes = [];\\n"
    "            this.lastEditableStroke = undefined;\\n"
    "            this.lastBrushHistoryChangeCount = undefined;\\n"
    "        }\\n"
    "        this.context = c;\\n"
    "    }",
)
'''
if old not in text:
    raise RuntimeError('setContext patch block not found')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
