import sys
from pathlib import Path

import fitz


destination = Path(sys.argv[1])
destination.parent.mkdir(parents=True, exist_ok=True)
document = fitz.open()
for rotation in [0, 90, 180, 270]:
    page = document.new_page(width=440, height=540)
    page.insert_text((85, 105), f"Source mapping at {rotation} degrees", fontsize=16)
    page.insert_text((85, 160), "FIRST REGION: preserve the same source identity.", fontsize=10)
    page.insert_text((85, 210), "SECOND REGION: visible after crop and rotation.", fontsize=10)
    page.insert_text((85, 260), "E = mc^2", fontsize=14)
    for row in range(4):
        page.draw_line((85, 300 + row * 30), (355, 300 + row * 30), color=(0.3, 0.3, 0.3), width=0.5)
    for column in range(3):
        page.draw_line((85 + column * 135, 300), (85 + column * 135, 390), color=(0.3, 0.3, 0.3), width=0.5)
    for x, y, value in [(92, 320, "Column A"), (227, 320, "Column B"), (92, 350, "1"), (227, 350, "2"), (92, 380, "3"), (227, 380, "4")]:
        page.insert_text((x, y), value, fontsize=10)
    page.set_cropbox(fitz.Rect(45, 55, 395, 485))
    page.set_rotation(rotation)
document.set_metadata({"title": "Crop and rotation validation", "author": "Continuous Reader acceptance fixture"})
document.save(destination)
print(destination)
