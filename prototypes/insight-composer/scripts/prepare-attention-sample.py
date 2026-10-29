"""Build the checked-in reading sample from the supplied v7 PDF and matching arXiv HTML.

Run with codex-tools Python (PyMuPDF + BeautifulSoup). No translation service is used.
The HTML is an extraction aid; the user's PDF remains the canonical source.
"""
from pathlib import Path
from collections import Counter
from copy import deepcopy
import hashlib
import json
import re
import sys
import zipfile
import fitz
from bs4 import BeautifulSoup, NavigableString

ROOT = Path(__file__).resolve().parents[3]
PACKAGE = ROOT / "prototypes/insight-composer/public/articles/attention-is-all-you-need"
WORK = ROOT / "tmp/attention"
WORK.mkdir(parents=True, exist_ok=True)
PDF = fitz.open(PACKAGE / "source.pdf")
html_path = Path(sys.argv[1]) if len(sys.argv) > 1 else WORK / "arxiv.html"
if not html_path.exists():
    raise SystemExit("Pass the matching arXiv v7 HTML path, or save https://arxiv.org/html/1706.03762v7 as tmp/attention/arxiv.html first.")
SOUP = BeautifulSoup(html_path.read_text(encoding="utf-8"), "html.parser")
ARTICLE = SOUP.select_one("article")
FOOTNOTES = []

def clean(text):
    return re.sub(r"\s+", " ", text).strip()

def inline(node):
    if isinstance(node, NavigableString):
        return str(node)
    classes = node.get("class", [])
    if node.name == "math":
        return "$" + node.get("alttext", "") + "$"
    if "ltx_note" in classes:
        content = node.select_one(".ltx_note_content")
        mark = node.select_one(".ltx_note_mark")
        if content and "ltx_note_frontmatter" not in classes:
            # LaTeXML renumbers body footnotes, while the supplied PDF uses 4, 5.
            number = {"footnote1": "4", "footnote2": "5"}.get(node.get("id"), mark.get_text(strip=True) if mark else node.get("id"))
            identity = "footnote-" + number
            copy = deepcopy(content)
            for extra in copy.select(".ltx_note_mark, .ltx_note_type"):
                extra.decompose()
            if not any(item["id"] == identity for item in FOOTNOTES):
                FOOTNOTES.append({"id": identity, "type": "para", "role": "footnote", "text": clean(inline(copy)), "source": [{"page": 4 if identity == "footnote-4" else 8}]})
            return "[" + number + "](#" + identity + ")"
        return ""
    if "ltx_tag" in classes or "ltx_rule" in classes:
        return ""
    value = "".join(inline(child) for child in node.children)
    if node.name == "a":
        href = node.get("href", "")
        if href.startswith(("#", "https://", "http://")):
            return "[" + clean(value) + "](" + href + ")"
    if "ltx_font_bold" in classes and value.strip():
        return "**" + value.strip() + "**"
    if "ltx_font_italic" in classes and value.strip():
        return "*" + value.strip() + "*"
    return value

def plain(text):
    text = re.sub(r"\$[^$]*\$", " ", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    return re.sub(r"[^a-z0-9]+", "", text.lower())

PAGES = [plain(page.get_text()) for page in PDF]
DEFAULT_PAGES = {"abstract1": 1, "S1": 2, "S2": 2, "S3": 2, "S3.SS1": 3, "S3.SS2": 3, "S3.SS2.SSS1": 4, "S3.SS2.SSS2": 4, "S3.SS2.SSS3": 5, "S3.SS3": 5, "S3.SS4": 5, "S3.SS5": 6, "S4": 6, "S5": 7, "S5.SS1": 7, "S5.SS2": 7, "S5.SS3": 7, "S5.SS4": 7, "S6": 8, "S6.SS1": 8, "S6.SS2": 8, "S6.SS3": 9, "S7": 10, "bib": 10, "Sx1": 13}

def page_source(identity, text):
    corrections = {"S3.SS2.SSS2.p4.1": [5], "S6.SS1.p2.1": [8], "S6.SS3.p3.1": [9, 10], "S5.SS4.SSS0.Px1": [8], "S5.SS4.SSS0.Px2": [8]}
    if identity in corrections:
        return [{"page": page} for page in corrections[identity]]
    normalized = plain(text)
    matched = []
    # Match several independent, non-mathematical fragments. Cross-page paragraphs
    # may have several source pages; no unverified bounding boxes are generated.
    if len(normalized) >= 32:
        for i, page in enumerate(PAGES):
            if any(normalized[start:start + 45] in page for start in range(0, max(1, len(normalized) - 44), 35) if len(normalized[start:start + 45]) >= 32):
                matched.append(i + 1)
    if not matched:
        nearest = max((key for key in DEFAULT_PAGES if identity == key or identity.startswith(key + ".")), key=len, default=None)
        if nearest:
            matched = [DEFAULT_PAGES[nearest]]
    return [{"page": i} for i in sorted(set(matched))]

def flatten_table(table):
    grid = {}
    rows = table.select("tr")
    for row_no, row in enumerate(rows):
        col = 0
        for cell in row.find_all(["td", "th"], recursive=False):
            while (row_no, col) in grid:
                col += 1
            value = clean(inline(cell))
            rs, cs = int(cell.get("rowspan", 1)), int(cell.get("colspan", 1))
            for dr in range(rs):
                for dc in range(cs):
                    grid[(row_no + dr, col + dc)] = value if dc == 0 else ""
            col += cs
    width = max(col for _, col in grid) + 1
    return [[grid.get((row, col), "") for col in range(width)] for row in range(len(rows))]

BLOCKS = []

def walk(node):
    if isinstance(node, NavigableString):
        return
    classes = node.get("class", [])
    identity = node.get("id") or node.parent.get("id")
    if node.name in ("h2", "h3", "h4", "h5", "h6"):
        text = clean(inline(node))
        tag = node.select_one(".ltx_tag")
        level = {"h2": 1, "h3": 2, "h4": 3, "h5": 4, "h6": 1}[node.name]
        if node.name == "h5" and identity.startswith("S7"):
            level = 1
        block = {"id": identity, "type": "heading", "level": level, "text": text}
        if tag:
            block["num"] = clean(tag.get_text())
        block["source"] = page_source(identity, text)
        BLOCKS.append(block)
        return
    if node.name == "figure":
        caption = clean(inline(node.select_one("figcaption")))
        number = re.search(r"[0-9]+", node.select_one(".ltx_tag").get_text()).group()
        if "ltx_table" in classes:
            grid = flatten_table(node.select_one("table"))
            header_count = 2 if number in ("1", "2", "3") else 1
            head = [[" / ".join(dict.fromkeys(row[col] for row in grid[:header_count] if row[col])) for col in range(len(grid[0]))]]
            body = grid[header_count:]
            if number == "1":
                head[0][2] = "Sequential Operations"
            if number == "2":
                # Remove the original purely visual spacer column. Keep the
                # final shared training-cost cell explicit in a separate column.
                head = [["Model", "BLEU · EN-DE", "BLEU · EN-FR", "Training cost · EN-DE (FLOPs)", "Training cost · EN-FR (FLOPs)", "Training cost · shared cell (FLOPs)"]]
                body = [[row[0], row[1], row[2], row[4] if i < 8 else "", row[5], row[4] if i >= 8 else ""] for i, row in enumerate(body)]
            block = {"id": identity, "type": "table", "num": number, "head": head, "rows": body, "caption": caption, "caption_pos": "above", "source": [{"page": {"1": 6, "2": 8, "3": 9, "4": 10}[number]}], "extensions": {"continous-reader.source-table": {"image": "figures/table-" + number + ".png", "normalization": "Merged header labels are joined. Row-spanning labels are repeated; other spanned cells remain empty. Original layout is retained in the table image and source PDF."}}}
        else:
            block = {"id": identity, "type": "figure", "num": number, "src": "figures/figure-" + number + ".png", "alt": "Figure " + number + ": " + caption, "caption": caption, "source": [{"page": {"1": 3, "2": 4, "3": 13, "4": 14, "5": 15}[number]}]}
        BLOCKS.append(block)
        return
    if node.name == "table" and ("ltx_equation" in classes or "ltx_equationgroup" in classes):
        rows = []
        for row in node.select("tr"):
            cells = [math.get("alttext", "").replace("\\displaystyle", "") for math in row.select("math")]
            rows.append(" & ".join(cells))
        tex = rows[0] if len(rows) == 1 else "\\begin{aligned}" + r" \\ ".join(rows) + "\\end{aligned}"
        block = {"id": identity, "type": "math", "tex": tex, "source": [{"page": {"S3.E1": 4, "S3.EGx1": 5, "S3.E2": 5, "S3.EGx2": 6, "S5.E3": 7}[identity]}]}
        tag = node.select_one(".ltx_tag_equation")
        if tag:
            block["tag"] = tag.get_text(strip=True).strip("()")
        BLOCKS.append(block)
        return
    if "ltx_itemize" in classes:
        items = [{"id": item["id"], "text": clean(" ".join(inline(p) for p in item.select("p")))} for item in node.find_all("li", recursive=False)]
        BLOCKS.append({"id": identity, "type": "list", "ordered": False, "items": items, "source": [{"page": 5}]})
        return
    if "ltx_biblist" in classes:
        for item in node.select(".ltx_bibitem"):
            text = clean(inline(item))
            number = int(re.search(r"\d+$", item["id"]).group())
            BLOCKS.append({"id": item["id"], "type": "para", "role": "reference", "text": f"[{number}] " + text, "source": [{"page": 10 if number <= 4 else 11 if number <= 24 else 12}]})
        return
    if node.name == "p":
        text = clean(inline(node))
        if text:
            block = {"id": identity, "type": "para", "text": text, "source": page_source(identity, text)}
            if node.find_parent(class_="ltx_abstract"):
                block["role"] = "abstract"
            BLOCKS.append(block)
        return
    if "ltx_authors" in classes or node.name == "h1":
        return
    for child in node.children:
        walk(child)

walk(ARTICLE)
# Retain the author contribution and affiliation notes from the supplied front page.
front = []
for identity, symbol in [("id1", "*"), ("id7", "†"), ("id10", "‡")]:
    note = ARTICLE.find(id=identity)
    if note and note.select_one(".ltx_note_content"):
        content = deepcopy(note.select_one(".ltx_note_content"))
        for extra in content.select(".ltx_note_mark, .ltx_note_type"):
            extra.decompose()
        front.append({"id": "author-note-" + identity, "type": "para", "role": "footnote", "text": symbol + " " + clean(inline(content)), "source": [{"page": 1}]})
insert = next(i for i, block in enumerate(BLOCKS) if block["id"] == "S1")
BLOCKS[insert:insert] = front
BLOCKS.insert(insert + len(front), {"id": "publication", "type": "para", "role": "publication", "text": "31st Conference on Neural Information Processing Systems (NIPS 2017), Long Beach, CA, USA.", "source": [{"page": 1}]})
BLOCKS[0]["role"] = "rights"
BLOCKS[0]["source"] = [{"page": 1}]
for note in FOOTNOTES:
    after = next(i for i, b in enumerate(BLOCKS) if "#" + note["id"] in b.get("text", ""))
    BLOCKS.insert(after + 1, note)

FIGURE_TEXT = {
    "S3.F1": "Inputs; Input Embedding; Positional Encoding; Multi-Head Attention; Add & Norm; Feed Forward; N×; Outputs (shifted right); Output Embedding; Masked Multi-Head Attention; Linear; Softmax; Output Probabilities.",
    "S3.F2": "Scaled Dot-Product Attention: MatMul; Scale; Mask (opt.); SoftMax; MatMul. Multi-Head Attention: Linear; Scaled Dot-Product Attention; Concat; Linear. Q; K; V; h.",
    "Sx1.F3": "It is in this spirit that a majority of American governments have passed new laws since 2009 making the registration or voting process more difficult. <EOS> <pad>",
    "Sx1.F4": "The Law will never be perfect, but its application should be just - this is what we are missing, in my opinion. <EOS> <pad>",
    "Sx1.F5": "The Law will never be perfect, but its application should be just - this is what we are missing, in my opinion. <EOS> <pad>",
}
for block in BLOCKS:
    if block["id"] in FIGURE_TEXT:
        block["image_text"] = FIGURE_TEXT[block["id"]]

figures = PACKAGE / "figures"
figures.mkdir(parents=True, exist_ok=True)
# Figure 1 is embedded as a high-resolution raster. Other figures are rendered
# directly from the supplied PDF, including the vector-only appendix diagrams.
pixmap = fitz.Pixmap(PDF, 128)
pixmap.save(figures / "figure-1.png")
PDF[3].get_pixmap(matrix=fitz.Matrix(3, 3), clip=fitz.Rect(139, 69, 476, 269), alpha=False).save(figures / "figure-2.png")
for number, index in [(3, 12), (4, 13), (5, 14)]:
    page = PDF[index]
    text_blocks = page.get_text("blocks")
    caption_y = next(b[1] for b in text_blocks if b[4].startswith(f"Figure {number}:"))
    boxes = [fitz.Rect(b[:4]) for b in text_blocks if b[3] < caption_y and "Attention Visualizations" not in b[4] and b[4].strip() != str(index + 1)]
    boxes += [d["rect"] for d in page.get_drawings() if d["rect"].y1 < caption_y]
    bounds = boxes[0]
    for box in boxes[1:]:
        bounds |= box
    bounds += (-4, -4, 4, 4)
    if number == 3:
        heading = next(b for b in text_blocks if "Attention Visualizations" in b[4])
        bounds.y0 = max(bounds.y0, heading[3] + 2)
    page.get_pixmap(matrix=fitz.Matrix(3, 3), clip=bounds, alpha=False).save(figures / f"figure-{number}.png")
for number, index, bottom in [(1, 5, 197), (2, 7, 247), (3, 8, 390), (4, 9, 242)]:
    PDF[index].get_pixmap(matrix=fitz.Matrix(3, 3), clip=fitz.Rect(105, 69, 508, bottom), alpha=False).save(figures / f"table-{number}.png")

for block in BLOCKS:
    if block["type"] == "figure":
        image = fitz.Pixmap(PACKAGE / block["src"])
        block.setdefault("extensions", {})["continous-reader.image-size"] = {"width": image.width, "height": image.height}

BLOCKS.insert(1, {"id": "author-details", "type": "para", "role": "author-details", "text": "Ashish Vaswani∗ — Google Brain — avaswani@google.com; Noam Shazeer∗ — Google Brain — noam@google.com; Niki Parmar∗ — Google Research — nikip@google.com; Jakob Uszkoreit∗ — Google Research — usz@google.com; Llion Jones∗ — Google Research — llion@google.com; Aidan N. Gomez∗† — University of Toronto — aidan@cs.toronto.edu; Łukasz Kaiser∗ — Google Brain — lukaszkaiser@google.com; Illia Polosukhin∗‡ — illia.polosukhin@gmail.com.", "source": [{"page": 1}]})

document = {"format": "continous-reader", "schema": 1, "id": "doc_attention_is_all_you_need_v7", "revision": 1, "meta": {"title": "Attention Is All You Need", "language": "en", "authors": "Ashish Vaswani · Noam Shazeer · Niki Parmar · Jakob Uszkoreit · Llion Jones · Aidan N. Gomez · Łukasz Kaiser · Illia Polosukhin", "date": "2017; arXiv v7: 2023-08-02"}, "source": {"path": "source.pdf", "media_type": "application/pdf", "sha256": hashlib.sha256((PACKAGE / "source.pdf").read_bytes()).hexdigest()}, "blocks": BLOCKS, "extensions": {"continous-reader.provenance": {"source": "User-supplied 1706.03762v7.pdf", "arxiv": "https://arxiv.org/abs/1706.03762v7", "extraction_aid": "https://arxiv.org/html/1706.03762v7", "pages": len(PDF), "translation": "Chinese translation prepared for this reading example; not an author-approved translation.", "source_discrepancies": ["The abstract and Table 2 report EN-FR BLEU 41.8; section 6.1 reports 41.0. Each original value is preserved.", "Section 5.4 says three types of regularization but explicitly names two. The wording is preserved."], "source_mapping": "Page-level locations checked against the supplied PDF. No inferred bounding boxes or claim of bidirectional PDF synchronization."}}}

def fingerprint(kind, obj):
    keys = {"meta": ["title"], "heading": ["text"], "para": ["text"], "list_item": ["text"], "figure": ["src", "alt", "caption", "image_text"], "table": ["head", "rows", "caption"], "math": ["tex"]}[kind]
    data = json.dumps(["en", kind] + [obj.get(key) for key in keys], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return "sha256:" + hashlib.sha256(data).hexdigest()

translation_path = Path(__file__).with_name("attention-translations.zh-CN.json")
if translation_path.exists():
    translations = json.loads(translation_path.read_text(encoding="utf-8"))
    cells = {
        "Layer Type": "层类型", "Complexity per Layer": "每层复杂度", "Sequential Operations": "顺序操作次数", "Maximum Path Length": "最大路径长度",
        "Self-Attention": "自注意力", "Recurrent": "循环层", "Convolutional": "卷积层", "Self-Attention (restricted)": "自注意力（受限）",
        "Model": "模型", "BLEU · EN-DE": "BLEU · 英德", "BLEU · EN-FR": "BLEU · 英法", "Training cost · EN-DE (FLOPs)": "训练代价 · 英德（FLOPs）", "Training cost · EN-FR (FLOPs)": "训练代价 · 英法（FLOPs）", "Training cost · shared cell (FLOPs)": "训练代价 · 原表共用值（FLOPs）",
        "Transformer (base model)": "Transformer（基础模型）", "Transformer (big)": "Transformer（大型）", "base": "基础模型", "big": "大型模型",
        "train / steps": "训练步数", "PPL / (dev)": "困惑度（开发集）", "BLEU / (dev)": "BLEU（开发集）", "params / $\\times 10^{6}$": "参数量 / $\\times 10^{6}$",
        "positional embedding instead of sinusoids": "以可学习的位置嵌入替代正弦编码", "**Parser**": "**分析器**", "**Training**": "**训练方式**",
        "WSJ only, discriminative": "仅 WSJ，判别式", "semi-supervised": "半监督", "multi-task": "多任务", "generative": "生成式", "Transformer (4 layers)": "Transformer（4 层）",
    }
    for block in BLOCKS:
        if block["type"] == "table":
            translations[block["id"]] = {"head": [[cells.get(c, c) for c in row] for row in block["head"]], "rows": [[cells.get(c, c.replace("Ensemble", "集成")) for c in row] for row in block["rows"]], "caption": translations["@table_captions"][block["id"]]}
        if block.get("role") == "reference":
            number = re.search(r"\d+$", block["id"]).group()
            spans = ARTICLE.find(id=block["id"]).select(".ltx_bibblock")
            title = clean(inline(spans[1]))
            translated_title = translations["@reference_titles"][number]
            if number == "12":
                translated_title += " 2001."
            translations[block["id"]] = block["text"].replace(title, translated_title, 1)
    for obj in [document["meta"]] + BLOCKS + [item for b in BLOCKS if b["type"] == "list" for item in b["items"]]:
        identity = obj.get("id", "meta")
        if identity in translations:
            kind = obj.get("type", "meta" if identity == "meta" else "list_item")
            payload = deepcopy(translations[identity])
            if isinstance(payload, str):
                payload = {"title" if kind == "meta" else "text": payload}
            payload["source_hash"] = fingerprint(kind, obj)
            obj["translations"] = {"zh-CN": payload}

(PACKAGE / "document.json").write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
(WORK / "english-blocks.txt").write_text("\n\n".join(f"{b['id']} [{b['type']}] {b.get('num','')}\n" + (b.get("text") or b.get("tex") or b.get("caption") or json.dumps(b.get("items"),ensure_ascii=False)) for b in BLOCKS), encoding="utf-8")
print(json.dumps({"blocks": len(BLOCKS), "types": dict(Counter(b["type"] for b in BLOCKS)), "footnotes": [x["id"] for x in front + FOOTNOTES]}, ensure_ascii=False))

if translation_path.exists():
    markdown = ["# " + document["meta"]["title"], "", document["meta"]["translations"]["zh-CN"]["title"], "", document["meta"]["authors"], "", document["meta"]["date"], "", "来源：[用户提供的 PDF](source.pdf) · [arXiv v7](https://arxiv.org/abs/1706.03762v7)。中文为本示例译文，非作者审定译本。", ""]
    for block in BLOCKS:
        translated = block.get("translations", {}).get("zh-CN", {})
        markdown += [f'<a id="{block["id"]}"></a>', ""]
        if block["type"] == "heading":
            prefix = "#" * min(6, block["level"] + 1) + " " + (block.get("num", "") + " " if block.get("num") else "")
            markdown += [prefix + block["text"] + " / " + translated.get("text", ""), ""]
        elif block["type"] == "para":
            markdown += [block["text"], "", translated.get("text", ""), ""]
        elif block["type"] == "math":
            markdown += ["$$", block["tex"] + ("\\tag{" + block["tag"] + "}" if "tag" in block else ""), "$$", ""]
        elif block["type"] == "figure":
            figure_text = lambda text: text.replace("<", "&lt;").replace(">", "&gt;")
            markdown += [f'![Figure {block["num"]}]({block["src"]})', "", f'Figure {block["num"]}: ' + block["caption"], "", f'图 {block["num"]}：' + translated["caption"], "", "Text in figure: " + figure_text(block.get("image_text", "")), "", "图中文字：" + figure_text(translated.get("image_text", "")), ""]
        elif block["type"] == "list":
            for item in block["items"]:
                markdown += ["- " + item["text"], "", "  " + item["translations"]["zh-CN"]["text"], ""]
        elif block["type"] == "table":
            for fields, label in [(block, "Table " + block["num"] + ": "), (translated, "表 " + block["num"] + "：")]:
                markdown += [label + fields["caption"], ""]
                matrix = fields["head"] + fields["rows"]
                for i, row in enumerate(matrix):
                    markdown.append("| " + " | ".join(c.replace("|", "\\|") for c in row) + " |")
                    if i == 0:
                        markdown.append("| " + " | ".join(["---"] * len(row)) + " |")
                markdown.append("")
            markdown += [f'[核对表 {block["num"]} 的原始版式](figures/table-{block["num"]}.png)', ""]
    markdown += ["---", "", "转换说明：原稿摘要与表 2 的英法 BLEU 为 41.8，而第 6.1 节为 41.0，均按原处保留。第 5.4 节写作三种正则化，但只有两个明确命名的小节，亦保留原文。表格合并表头展平，跨行标签重复显示；表 2 的跨列训练代价单独置于“原表共用值”列。参考文献仅翻译题名，作者与出版信息沿用原始著录。", ""]
    (PACKAGE / "article.bilingual.md").write_text("\n".join(markdown), encoding="utf-8")
    with zipfile.ZipFile(PACKAGE / "article-package.zip", "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in [PACKAGE / "README.md", PACKAGE / "document.json", PACKAGE / "article.bilingual.md", PACKAGE / "source.pdf", *sorted(figures.glob("*.png"))]:
            archive.write(path, "attention-is-all-you-need/" + path.relative_to(PACKAGE).as_posix())
