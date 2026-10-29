import argparse
from pathlib import Path
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("implementation", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--crop", type=int, nargs=4)
args = parser.parse_args()
source = Image.open(args.source).convert("RGB")
implementation = Image.open(args.implementation).convert("RGB")
if source.size != implementation.size:
    raise ValueError(f"Expected equal captures: {source.size} != {implementation.size}")
if args.crop:
    source = source.crop(args.crop)
    implementation = implementation.crop(args.crop)
width, height = source.size
combined = Image.new("RGB", (width * 2 + 12, height + 28), "#e6e8eb")
draw = ImageDraw.Draw(combined)
draw.text((8, 8), "SOURCE", fill="#20252b")
draw.text((width + 20, 8), "IMPLEMENTATION", fill="#20252b")
combined.paste(source, (0, 28))
combined.paste(implementation, (width + 12, 28))
args.output.parent.mkdir(parents=True, exist_ok=True)
combined.save(args.output)
