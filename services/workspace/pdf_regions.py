"""Conservative, source-page-scoped text mapping for existing PDF documents.

These are derived display coordinates, never edits to the document revision.
Unknown, ambiguous and image-only content deliberately stays page-only.
"""

from difflib import SequenceMatcher
from collections import Counter
import contextlib
from html.parser import HTMLParser
import re
import sys
import unicodedata

import fitz


def normalized_text(value):
    value = re.sub(r"\[([^\[\]]*)\]\([^)]*\)", r"\1", value or "")
    value = re.sub(r"\\[A-Za-z]+", "", value)
    return "".join(c for c in unicodedata.normalize("NFKD", value).casefold() if c.isalnum())


def valid_box(box):
    return (isinstance(box, list) and len(box) == 4
            and all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in box)
            and box[0] < box[2] and box[1] < box[3])


def page_lines(page, normalize_box):
    result = []
    for block in page.get_text("dict", sort=True, flags=0)["blocks"]:
        for line in block.get("lines", []):
            value = normalized_text("".join(span.get("text", "") for span in line["spans"]))
            box = normalize_box(page, line["bbox"])
            if value and box:
                result.append({"text": value, "page": page.number + 1, "box": box})
    return result


def match_lines(query, lines):
    """Accept a unique near-complete contiguous source passage only."""
    if len(query) < 8 or not lines:
        return []
    text = "".join(line["text"] for line in lines)
    start = text.find(query)
    if start >= 0:
        if text.find(query, start + 1) >= 0:
            return []
        end = start + len(query)
        spans = [(start, end)]
    else:
        # Very short strings (headings, labels) need an exact match. For prose,
        # tolerate TeX, ligatures, hyphenation and minor extraction differences.
        if len(query) < 40:
            return []
        matches = [m for m in SequenceMatcher(None, query, text, autojunk=False).get_matching_blocks() if m.size >= 4]
        if not matches:
            return []
        # Ignore incidental matches outside the paragraph's first/last strong
        # anchors, rather than allowing a common word to reach an adjacent block.
        strong = [m for m in matches if m.size >= 12]
        if not strong:
            return []
        first, last = strong[0], strong[-1]
        if first.a > max(12, len(query) * .06) or len(query) - (last.a + last.size) > max(12, len(query) * .06):
            return []
        start, end = first.b, last.b + last.size
        within = [m for m in matches if start <= m.b and m.b + m.size <= end]
        coverage = sum(m.size for m in within) / len(query)
        if coverage < .86:
            return []
        # A second occurrence of the main anchor is not enough evidence to
        # distinguish identical paragraphs on the declared source pages.
        anchor = max(strong, key=lambda m: m.size)
        needle = query[anchor.a:anchor.a + anchor.size]
        if text.count(needle) != 1:
            return []
        spans = [(m.b, m.b + m.size) for m in strong]
    offset, selected = 0, []
    bounds = {}
    for line in lines:
        next_offset = offset + len(line["text"])
        if any(offset < high and next_offset > low for low, high in spans):
            previous = bounds.get(line["page"], (offset, next_offset))
            bounds[line["page"]] = (min(previous[0], offset), max(previous[1], next_offset))
        offset = next_offset
    offset = 0
    for line in lines:
        next_offset = offset + len(line["text"])
        low, high = bounds.get(line["page"], (0, 0))
        if offset < high and next_offset > low:
            selected.append(line)
        offset = next_offset
    # Page headers, footers and intervening figures between a split paragraph
    # are excluded by per-page bounds. An excessive within-page gap is unsafe.
    if sum(len(line["text"]) for line in selected) > len(query) * 1.35 + 100:
        return []
    return selected


def match_bold_heading(query, pdf, pages, normalize_box, number=None):
    """Resolve a repeated/short heading only from one exact bold source span."""
    if not query:
        return []
    matches = []
    for page_number in pages:
        page = pdf[page_number - 1]
        text_blocks = page.get_text("dict", sort=True, flags=0)["blocks"]
        spans = [span for block in text_blocks for line in block.get("lines", []) for span in line["spans"]]
        for span in spans:
            if not span["flags"] & 16 or normalized_text(span["text"]) != query:
                continue
            bounds = fitz.Rect(span["bbox"])
            if number is not None:
                labels = [other for other in spans if other["flags"] & 16
                          and other["text"].strip() == str(number)
                          and abs(other["bbox"][1] - bounds.y0) < 1
                          and 0 < bounds.x0 - other["bbox"][2] < 24]
                if len(labels) == 1:
                    bounds |= fitz.Rect(labels[0]["bbox"])
            box = normalize_box(page, bounds)
            if box:
                matches.append({"page": page_number, "box": box, "provenance": "pdf-heading"})
    return matches if len(matches) == 1 else []


def table_plain(value):
    value = re.sub(r"\[([^\[\]]*)\]\([^)]*\)", r"\1", value or "")
    value = re.sub(r"\\(?:dfrac|tfrac|frac)\{([^{}]+)\}\{([^{}]+)\}", r"\1/\2", value)
    value = re.sub(r"\\[A-Za-z]+", "", value)
    return unicodedata.normalize("NFKD", value).casefold().translate(str.maketrans({"−": "-", "–": "-", "—": "-"}))


def table_text(value):
    # Numeric punctuation is semantic: 1.2 != 12, and -5 != 5.
    return "".join(c for c in table_plain(value) if c.isalnum() or c in ".-+%/")


class SemanticTables(HTMLParser):
    """Read source table cells only; captions/styles/translations give no evidence."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self.table, self.row, self.cell = [], None, None, None
        self.depth, self.head, self.math_depth, self.nested = 0, False, None, 0

    def handle_starttag(self, tag, attributes):
        attributes = dict(attributes)
        if tag not in ("br", "hr", "img", "input", "meta", "link", "wbr"):
            self.depth += 1
        if tag == "table":
            if self.table is not None:
                self.nested += 1
                self.table["invalid"] = True
            else:
                self.table = {"head": [], "rows": []}
        if self.table is None or self.nested:
            return
        if tag == "thead":
            self.head = True
        elif tag == "tr":
            self.row = []
        elif tag in ("td", "th") and self.row is not None:
            self.cell = {"text": "", "spans": attributes.get("rowspan", "1") != "1", "header": self.head or attributes.get("scope") == "col"}
        if self.cell is not None and attributes.get("data-tex") is not None:
            self.cell["text"] += attributes["data-tex"]
            self.math_depth = self.depth
        elif tag == "br" and self.cell is not None:
            self.cell["text"] += " "

    def handle_endtag(self, tag):
        if tag == "table" and self.nested:
            self.nested -= 1
        elif self.table is not None and not self.nested:
            if tag in ("td", "th") and self.cell is not None:
                self.row.append(self.cell)
                self.cell = None
            elif tag == "tr" and self.row is not None:
                self.table["head" if self.row and all(c["header"] for c in self.row) else "rows"].append(self.row)
                self.row = None
            elif tag == "thead":
                self.head = False
            elif tag == "table":
                if not self.table.get("invalid"):
                    self.tables.append(self.table)
                self.table, self.row, self.cell, self.head = None, None, None, False
        if self.math_depth is not None and self.depth <= self.math_depth:
            self.math_depth = None
        self.depth = max(0, self.depth - 1)

    def handle_data(self, value):
        if self.cell is not None and self.math_depth is None and not self.nested:
            self.cell["text"] += value


def source_tables(block):
    if block.get("type") == "table":
        return [{part: [[{"text": str(cell), "spans": False} for cell in row] for row in block.get(part, [])] for part in ("head", "rows")}]
    if block.get("type") == "html" and isinstance(block.get("html"), str):
        parser = SemanticTables()
        parser.feed(block["html"])
        return parser.tables
    return []


def table_candidates(pdf, number, normalize_box):
    """Find actual geometric borders on a copy; never mutate source page boxes."""
    original = pdf[number - 1]
    with fitz.open() as copy:
        copy.insert_pdf(pdf, from_page=number - 1, to_page=number - 1)
        page = copy[0]
        page.set_rotation(0)
        rectangles, groups, group_evidence = [], [], []
        for drawing in page.get_drawings():
            for item in drawing["items"]:
                line = None
                if item[0] == "l" and abs(item[1].y - item[2].y) < .7:
                    line = (min(item[1].x, item[2].x), max(item[1].x, item[2].x), (item[1].y + item[2].y) / 2)
                elif item[0] == "re" and item[1].height < 1:
                    line = (item[1].x0, item[1].x1, (item[1].y0 + item[1].y1) / 2)
                if line is None or line[1] - line[0] < 40:
                    continue
                group = next((group for group in groups if abs(group[0] - line[0]) < 2 and abs(group[1] - line[1]) < 2), None)
                if group is None:
                    groups.append([line[0], line[1], [line[2]]])
                else:
                    group[2].append(line[2])
        for x0, x1, ys in groups:
            ys = sorted(set(round(y, 2) for y in ys))
            # Pathological drawings are not grounds for inventing a huge box.
            if len(ys) > 32:
                continue
            for start in range(len(ys)):
                for end in range(start + 1, len(ys)):
                    if 12 <= ys[end] - ys[start] <= page.rect.height * .95:
                        rectangles.append(fitz.Rect(x0, ys[start], x1, ys[end]))
        # find_tables may rewrite crop geometry even on a copy. Run it on a
        # second disposable copy; text extraction below keeps its original crop.
        with fitz.open() as detection:
            detection.insert_pdf(copy, from_page=0, to_page=0)
            with contextlib.redirect_stdout(sys.stderr):
                try:
                    found = detection[0].find_tables()
                    for table in found.tables:
                        if table.row_count < 2 or table.col_count < 2:
                            continue
                        rect = fitz.Rect(table.bbox)
                        rectangles.append(rect)
                        spans = {}
                        for row in table.extract():
                            label = table_text(row[0] or "")
                            count = max((len([line for line in (value or "").splitlines() if line.strip()]) for value in row[1:]), default=0)
                            if label and count > 1:
                                spans[label] = max(spans.get(label, 0), count)
                        group_evidence.append((rect, spans))
                except Exception:
                    pass
        candidates, seen = [], set()
        for rect in rectangles[:512]:
            key = tuple(round(v, 1) for v in rect)
            if key in seen or rect.is_empty or not page.rect.contains(rect):
                continue
            seen.add(key)
            box = normalize_box(original, rect)
            if box:
                spans = {}
                for detected, evidence in group_evidence:
                    overlap = (rect & detected).get_area()
                    if overlap / max(rect.get_area(), detected.get_area()) >= .98:
                        spans.update(evidence)
                candidates.append({"page": number, "box": box, "raw": page.get_text("text", clip=rect, sort=True), "rowGroups": spans})
        return candidates


NUMBER = re.compile(r"(?<![\w.])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?%?(?![\w.])")


def verified_table(table, candidate):
    rows = [[cell for cell in row if table_text(cell["text"])] for row in table["rows"]]
    cells = [cell for row in rows for cell in row]
    head = [cell["text"] for row in table["head"] for cell in row]
    if len(cells) < 4 or len(rows) < 2 or sum(len(table_text(cell["text"])) for cell in cells) < 12:
        return False
    text = table_text(candidate["raw"])
    if any(table_text(cell["text"]) not in text for cell in cells):
        return False
    # Validate row associations, not just a bag of values. Repeated row-group
    # labels in normalized tables and HTML rowspan cells are checked separately.
    labels = Counter(table_text(row[0]["text"]) for row in rows if row)
    row_queries = []
    for row in rows:
        values = []
        for index, cell in enumerate(row):
            value = table_text(cell["text"])
            repeated_group = index == 0 and labels[value] > 1 and candidate.get("rowGroups", {}).get(value, 0) >= labels[value]
            if not cell.get("spans") and not repeated_group:
                values.append(value)
        if values:
            row_queries.append("".join(values))
    if any(text.count(query) < count for query, count in Counter(row_queries).items()):
        return False
    # Preserve exact numeric tokens as well as decimal/minus/percent spelling;
    # this prevents 12 from matching adjacent 1 + 2, or -5 from matching 5.
    required = Counter()
    for cell in cells:
        value = table_plain(cell["text"]).strip(" *$_{}")
        if NUMBER.fullmatch(value):
            required[value] += 1
    actual = Counter(NUMBER.findall(table_plain(candidate["raw"])))
    if any(actual[value] < count for value, count in required.items()):
        return False
    if head and row_queries:
        # Header evidence must precede the first complete body row. In
        # particular, a lower border must not crop off a short upper header row.
        plain = table_plain(candidate["raw"])
        offsets = [index for index, char in enumerate(plain) if char.isalnum() or char in ".-+%/"]
        first_row = text.find(row_queries[0])
        header_text = text[:first_row]
        header_words = {table_text(word) for word in plain[:offsets[first_row]].split()} if first_row >= 0 else set()
        for row in table["head"]:
            tokens = {table_text(token) for cell in row for token in re.split(r"\s+|[·(),/]", cell["text"])}
            tokens.discard("")
            weight = sum(map(len, tokens))
            found = sum(len(token) for token in tokens if (token in header_words if len(token) == 1 else token in header_text))
            if weight and found < weight * .7:
                return False
    # Reject boxes that also encompass unrelated prose or multiple copies.
    expected = sum(len(table_text(cell["text"])) for cell in cells) + sum(len(table_text(value)) for value in head)
    return len(text) <= expected * 1.65 + 32


def match_table(table, candidates):
    matches = [candidate for candidate in candidates if verified_table(table, candidate)]
    matches.sort(key=lambda c: (c["box"][2] - c["box"][0]) * (c["box"][3] - c["box"][1]))
    unique = []
    for candidate in matches:
        rect = fitz.Rect(candidate["box"])
        if not any(candidate["page"] == other["page"] and (rect & fitz.Rect(other["box"])).get_area() / min(rect.get_area(), fitz.Rect(other["box"]).get_area()) >= .9 for other in unique):
            unique.append(candidate)
    if len(unique) != 1:
        return []
    return [{"page": unique[0]["page"], "box": unique[0]["box"], "provenance": "pdf-table"}]


def source_regions(pdf, blocks, normalize_box):
    cache, tables, regions = {}, {}, []
    for block in blocks:
        if block.get("origin") == "user":
            continue
        if block.get("type") == "list" and isinstance(block.get("items"), list):
            item_regions = []
            for item in block["items"]:
                if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                    continue
                # An item's own coordinates are authoritative. Inherited list
                # boxes describe the whole list, so use only their pages when
                # trying to derive a more precise item passage.
                item_sources = item.get("source") if "source" in item else [
                    {"page": source.get("page")} for source in block.get("source", [])]
                if not isinstance(item_sources, list):
                    continue
                candidate = {"id": block["id"], "type": "para", "text": item.get("text", ""), "source": item_sources}
                for region in source_regions(pdf, [candidate], normalize_box):
                    item_regions.append({**region, "itemId": item["id"], "regionIndex": len(item_regions)})
            if item_regions:
                regions.extend(item_regions)
                # Do not cover precise child hit targets with a duplicate
                # whole-list region. Keep an explicit parent fallback only if
                # some item could not be reliably located.
                if all(valid_box(region.get("box")) for region in item_regions):
                    continue
                parent_sources = [source for source in block.get("source", []) if valid_box(source.get("box"))]
                for parent_index, source in enumerate(parent_sources):
                    if isinstance(source.get("page"), int) and 1 <= source["page"] <= len(pdf):
                        regions.append({"blockId": block["id"], "page": source["page"], "regionIndex": len(item_regions) + parent_index, "box": source["box"], "provenance": "source"})
                continue
        sources = [s for s in block.get("source", []) if isinstance(s.get("page"), int) and 1 <= s["page"] <= len(pdf)]
        if not sources:
            continue
        missing = [s for s in sources if not valid_box(s.get("box"))]
        derived = []
        # Captions never establish an object's extent. Table coordinates need
        # real geometric borders plus verified source header/body cell content.
        if missing and block.get("type") in ("para", "heading", "code"):
            pages = sorted({s["page"] for s in sources})
            for number in pages:
                if number not in cache:
                    cache[number] = page_lines(pdf[number - 1], normalize_box)
            derived = match_lines(normalized_text(block.get("text", "")), [line for number in pages for line in cache[number]])
            if not derived and block.get("type") == "heading":
                derived = match_bold_heading(normalized_text(block.get("text", "")), pdf, pages, normalize_box, block.get("num"))
        elif missing and block.get("type") in ("table", "html"):
            queries = source_tables(block)
            pages = sorted({s["page"] for s in sources})
            if queries:
                for number in pages:
                    if number not in tables:
                        tables[number] = table_candidates(pdf, number, normalize_box)
                candidates = [candidate for number in pages for candidate in tables[number]]
                for query in queries:
                    derived.extend(match_table(query, candidates))
        index = 0
        for source in sources:
            supplied = valid_box(source.get("box"))
            matches = [line for line in derived if line["page"] == source["page"]] if not supplied else []
            if supplied:
                entries = [{"box": source["box"], "provenance": "source"}]
            elif matches:
                entries = [{"box": line["box"], "provenance": line.get("provenance", "pdf-text")} for line in matches]
            else:
                entries = [{}]
            for entry in entries:
                regions.append({"blockId": block["id"], "page": source["page"], "regionIndex": index, **entry})
                index += 1
    return regions
