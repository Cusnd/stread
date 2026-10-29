import json
import math
import sys

import fitz
from pdf_regions import source_regions


def page_info(page):
    rect = page.rect
    if not all(math.isfinite(v) for v in rect) or rect.width <= 0 or rect.height <= 0:
        raise ValueError("PDF page bounds are invalid")
    return {"page": page.number + 1, "width": rect.width, "height": rect.height, "rotation": page.rotation}


def normalized(page, rectangle):
    displayed = fitz.Rect(rectangle) * page.rotation_matrix
    visible = displayed & page.rect
    if visible.is_empty or visible.width <= 0 or visible.height <= 0:
        return None
    return [max(0, min(1, visible.x0 / page.rect.width)), max(0, min(1, visible.y0 / page.rect.height)),
            max(0, min(1, visible.x1 / page.rect.width)), max(0, min(1, visible.y1 / page.rect.height))]


def main():
    request = json.load(sys.stdin)
    if request.get("action") == "coordinate_probe":
        result = []
        for rotation in [0, 90, 180, 270]:
            document = fitz.open()
            page = document.new_page(width=400, height=500)
            page.insert_text((100, 140), "Mapped text", fontsize=16)
            page.set_cropbox(fitz.Rect(50, 60, 350, 460))
            page.set_rotation(rotation)
            rectangle = page.get_text("blocks")[0][:4]
            pixmap = page.get_pixmap(alpha=False)
            result.append({**page_info(page), "box": normalized(page, rectangle), "pixelWidth": pixmap.width, "pixelHeight": pixmap.height})
            if request.get("outputPath") and rotation == 90:
                document.save(request["outputPath"])
            document.close()
        return result
    with fitz.open(request["path"]) as pdf:
        if pdf.needs_pass:
            raise ValueError("Encrypted PDF requires an unlocked original")
        if not 1 <= len(pdf) <= 2000:
            raise ValueError("PDF must contain 1 to 2000 pages")
        action = request["action"]
        if action == "manifest":
            return {"pages": [page_info(page) for page in pdf]}
        if action == "regions":
            return {"regions": source_regions(pdf, request.get("blocks", []), normalized)}
        if action == "render":
            number = request["page"]
            if not isinstance(number, int) or not 1 <= number <= len(pdf):
                raise ValueError("Page number is outside this PDF")
            page = pdf[number - 1]
            info = page_info(page)
            width = max(300, min(1800, int(request.get("width", 1200))))
            scale = min(width / page.rect.width, (16000000 / (page.rect.width * page.rect.height)) ** 0.5)
            pixmap = page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False)
            pixmap.save(request["outputPath"])
            return {**info, "pixelWidth": pixmap.width, "pixelHeight": pixmap.height}
        raise ValueError("Unknown PDF operation")


try:
    print(json.dumps({"ok": True, "result": main()}, ensure_ascii=False))
except Exception as failure:
    print(json.dumps({"ok": False, "error": str(failure), "type": type(failure).__name__}, ensure_ascii=False))
    sys.exit(1)
