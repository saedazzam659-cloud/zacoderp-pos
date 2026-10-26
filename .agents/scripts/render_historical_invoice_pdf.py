from pathlib import Path
import fitz

source = Path("attached_assets/0_4_5899727847001430712_(1)_1793040606511.pdf")
output = Path(".agents/outputs/historical-invoice-page-1.png")
output.parent.mkdir(parents=True, exist_ok=True)

document = fitz.open(source)
print(f"pages={document.page_count}")
for index, page in enumerate(document):
    images = page.get_images(full=True)
    text = page.get_text()
    print(f"page={index + 1} size={page.rect.width:.0f}x{page.rect.height:.0f} text_chars={len(text)} images={len(images)}")
    if index == 0:
        page.get_pixmap(matrix=fitz.Matrix(2, 2), alpha=False).save(output)
        print(f"rendered={output}")
