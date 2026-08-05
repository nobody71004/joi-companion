"""Generate the JOI app icon — her face on a purple hologram background.
Outputs:
  public/img/icon.png   (512px, used by Electron window + tray)
  build/icon.ico        (multi-size, embedded in the EXE)
Run: venv/Scripts/python.exe build/make_icon.py
"""
from PIL import Image, ImageDraw, ImageFilter, ImageOps
import os

S = 512  # master canvas
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(BASE, "public", "img", "images.jpg")
OUT_PNG = os.path.join(BASE, "public", "img", "icon.png")
OUT_ICO = os.path.join(BASE, "build", "icon.ico")

# ---- 1. crop a square face region from the render ----
# calibrated landmarks on images.jpg: eyes ~44%+62% x, 30-32% y; mouth 52.5% y 43%
img = Image.open(SRC).convert("RGB")
W, H = img.size
cx, cy = 0.53, 0.355
half_x, half_y = 0.20, 0.27  # generous frame around the face
x0 = max(0, int((cx - half_x) * W)); x1 = min(W, int((cx + half_x) * W))
y0 = max(0, int((cy - half_y) * H)); y1 = min(H, int((cy + half_y) * H))
face = img.crop((x0, y0, x1, y1))
face = face.resize((S, S), Image.LANCZOS)

# ---- 2. soft circular mask (hologram orb) ----
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).ellipse((20, 20, S - 20, S - 20), fill=255)
mask = mask.filter(ImageFilter.GaussianBlur(6))
face_c = Image.new("RGBA", (S, S), (0, 0, 0, 0))
face_c.paste(face, (0, 0), mask)

# ---- 3. purple hologram background: radial gradient + glow ring ----
bg = Image.new("RGB", (S, S), (5, 2, 12))
d = ImageDraw.Draw(bg)
cx, cy = S // 2, S // 2
R = int(S * 0.72)
steps = 90
for i in range(steps, 0, -1):
    t = i / steps
    r = int(R * (1 - t))
    col = (
        int(58 * (1 - t) + 6 * t),
        int(24 * (1 - t) + 3 * t),
        int(96 * (1 - t) + 14 * t),
    )
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=col)

# glow ring around the orb
ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rd = ImageDraw.Draw(ring)
for w in range(16, 0, -1):
    a = int(70 - (16 - w) * 4)
    rd.ellipse((24 - w, 24 - w, S - 24 + w, S - 24 + w), outline=(255, 120, 210, a), width=2)
ring = ring.filter(ImageFilter.GaussianBlur(2))
bg = Image.alpha_composite(bg.convert("RGBA"), ring)

# ---- 4. composite ----
icon = Image.alpha_composite(bg, face_c)

# subtle top-light / hologram shimmer
shimmer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
sd = ImageDraw.Draw(shimmer)
sd.ellipse((cx - int(S * 0.30), cy - int(S * 0.34), cx + int(S * 0.30), cy - int(S * 0.10)),
           fill=(255, 200, 255, 26))
shimmer = shimmer.filter(ImageFilter.GaussianBlur(14))
icon = Image.alpha_composite(icon, shimmer)

icon.convert("RGB").save(OUT_PNG, "PNG")
icon.save(OUT_ICO, "ICO", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
print("icon.png ->", OUT_PNG)
print("icon.ico ->", OUT_ICO)
