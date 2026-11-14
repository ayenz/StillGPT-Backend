"""Build docs/pdf/StillGPT-Frontend-Guide.pdf from docs/FRONTEND_GUIDE.md + docs/API.md.

Usage:  python3 -m venv .pdfenv && .pdfenv/bin/pip install markdown xhtml2pdf
        .pdfenv/bin/python scripts/build_pdf.py . docs/pdf/StillGPT-Frontend-Guide.pdf
Fonts: macOS Arial Unicode + Courier New (adjust the @font-face paths on Linux).
"""
import re, sys, markdown
from xhtml2pdf import pisa

repo, out = sys.argv[1], sys.argv[2]
guide = open(f"{repo}/docs/FRONTEND_GUIDE.md", encoding="utf8").read()
api = open(f"{repo}/docs/API.md", encoding="utf8").read()

EMOJI = re.compile("[\U0001F300-\U0001FAFF✨️]")  # glyphs the PDF fonts lack
LIST = re.compile(r"^\s*(?:[-*+]|\d+\.)\s")
def separate_lists(text):
    """Python-Markdown needs a blank line before a list that follows a paragraph (GitHub doesn't)."""
    out, fenced, prev = [], False, ""
    for line in text.split("\n"):
        if line.lstrip().startswith("```"):
            fenced = not fenced
        elif not fenced and LIST.match(line) and prev.strip() and not LIST.match(prev) and not prev.startswith("|"):
            out.append("")
        out.append(line)
        prev = line
    return "\n".join(out)

def md(text):
    text = separate_lists(EMOJI.sub("", text))
    text = re.sub(r"^- \[[^\]]+\]\(#[^)]+\)\n", "", text, flags=re.M)  # in-page TOC links (not navigable in PDF)
    html = markdown.markdown(text, extensions=["tables", "fenced_code", "sane_lists"])
    # break long unspaced tokens inside table cells so columns don't overflow
    return html

CSS = """
@font-face { font-family: Body; src: url('/Library/Fonts/Arial Unicode.ttf'); }
@font-face { font-family: Mono; src: url('/System/Library/Fonts/Supplemental/Courier New.ttf'); }
@page { size: a4 portrait; margin: 2cm 1.7cm 2cm 1.7cm;
  @frame footer { -pdf-frame-content: footer; bottom: 0.8cm; margin-left: 1.7cm; margin-right: 1.7cm; height: 1cm; } }
body { font-family: Body; font-size: 9.5pt; line-height: 1.45; color: #1f2933; }
h1 { font-size: 19pt; color: #b42318; margin: 0 0 6pt 0; padding-bottom: 4pt; border-bottom: 1.5pt solid #b42318; -pdf-keep-with-next: true; }
h2 { font-size: 13.5pt; color: #b42318; margin: 14pt 0 4pt 0; -pdf-keep-with-next: true; }
h3 { font-size: 11pt; color: #3e4c59; margin: 10pt 0 3pt 0; -pdf-keep-with-next: true; }
h4 { font-size: 10pt; color: #3e4c59; margin: 8pt 0 2pt 0; -pdf-keep-with-next: true; }
p { margin: 0 0 5pt 0; }
ul, ol { margin: 0 0 5pt 0; }
li { margin-bottom: 2pt; }
code { font-family: Mono; font-size: 8.5pt; background-color: #f1f3f5; color: #9a1b12; }
pre { font-family: Mono; font-size: 7.6pt; line-height: 1.3; background-color: #f6f8fa; border: 0.6pt solid #d9dee3;
      padding: 6pt; margin: 2pt 0 7pt 0; color: #1f2933; }
pre code { background-color: transparent; color: #1f2933; font-size: 7.6pt; }
table { border-collapse: collapse; margin: 3pt 0 8pt 0; width: 100%; }
th { background-color: #fbe9e7; color: #7a1a10; font-weight: bold; border: 0.6pt solid #d9dee3; padding: 3pt 4pt; font-size: 8.5pt; text-align: left; }
td { border: 0.6pt solid #d9dee3; padding: 3pt 4pt; font-size: 8.5pt; vertical-align: top; }
blockquote { margin: 4pt 0 8pt 0; padding: 5pt 8pt; background-color: #fff6e5; border-left: 2pt solid #f0a020; color: #5a4300; }
hr { color: #d9dee3; margin: 8pt 0; }
a { color: #b42318; text-decoration: none; }
.cover { background-color: #1d1b1b; color: #ffffff; padding: 4cm 1.2cm 9cm 1.2cm; }
.cover h1 { color: #ffffff; border: none; font-size: 34pt; margin-bottom: 4pt; }
.kicker { color: #ff8a73; font-size: 11pt; letter-spacing: 1pt; }
.sub { color: #e6e6e6; font-size: 14pt; margin-top: 6pt; }
.meta { color: #bdbdbd; font-size: 10pt; margin-top: 40pt; line-height: 1.8; }
.part { font-size: 10pt; color: #b42318; letter-spacing: 1pt; margin-bottom: 2pt; }
#footer { font-size: 7.5pt; color: #8a94a0; text-align: center; }
"""

cover = """
<div class="cover">
  <div class="kicker">STILLGPT · PERSONAL LLM BACKEND</div>
  <h1>Frontend Integration Guide</h1>
  <div class="sub">Streaming chat, photos &amp; documents, prompt enhancer, images &amp; video — for the PWA (and Flutter later)</div>
  <div class="meta">
    Production base URL: <b>https://qrouter.ayenz.my.id/api/v1</b><br/>
    Backend version: 0.1 · November 2026<br/><br/>
    Part A — Integration guide<br/>
    Part B — Full API reference
  </div>
</div>
"""

html = f"""<html><head><meta charset="utf-8"/><style>{CSS}</style></head><body>
<div id="footer">StillGPT · Frontend Integration Guide · page <pdf:pagenumber/> / <pdf:pagecount/></div>
{cover}
<pdf:nextpage/>
<div class="part">PART A</div>
{md(guide)}
<pdf:nextpage/>
<div class="part">PART B</div>
{md(api)}
</body></html>"""

with open(out, "wb") as f:
    res = pisa.CreatePDF(html, dest=f, encoding="utf-8")
print("errors:", res.err, "->", out)
