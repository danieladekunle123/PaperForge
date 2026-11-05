"""Prints facts about a PDF as JSON. End-to-end tests use this to check exported files independently.

Usage: python scripts/inspect_pdf.py <file> [password]
"""

import json
import sys

import pymupdf


def main():
    path = sys.argv[1]
    password = sys.argv[2] if len(sys.argv) > 2 else None
    pymupdf.TOOLS.mupdf_display_errors(False)
    with pymupdf.open(path) as doc:
        needs_password = bool(doc.needs_pass)
        if needs_password and password:
            doc.authenticate(password)
        pages = []
        locked = needs_password and not password
        for page in [] if locked else doc:
            pages.append(
                {
                    "text": page.get_text("text"),
                    "rotation": page.rotation,
                    "width": round(page.rect.width, 1),
                    "height": round(page.rect.height, 1),
                    "images": len(page.get_images()),
                    # Images actually painted. `images` can also count a resource shared between pages.
                    "drawnImages": len(page.get_image_info()),
                }
            )
        print(
            json.dumps(
                {
                    "pageCount": 0 if locked else doc.page_count,
                    "needsPassword": needs_password,
                    "metadata": doc.metadata,
                    "pages": pages,
                }
            )
        )


if __name__ == "__main__":
    main()
