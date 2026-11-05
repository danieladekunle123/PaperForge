# PyInstaller build definition: run through `npm run build:worker`.
from PyInstaller.utils.hooks import collect_all

datas, binaries, hiddenimports = collect_all("pymupdf")
datas2, binaries2, hidden2 = collect_all("PIL")

analysis = Analysis(
    ["entry.py"],
    pathex=["."],
    binaries=binaries + binaries2,
    datas=datas + datas2,
    hiddenimports=hiddenimports + hidden2,
    # Heavy optional imports that PyMuPDF and Pillow never need here.
    excludes=[
        "tkinter", "matplotlib", "numpy", "IPython", "pytest", "PyQt5", "PySide6", "PIL.ImageTk",
        "onnxruntime", "pymupdf4llm", "pymupdf_layout", "networkx",
    ],
    noarchive=False,
)
pyz = PYZ(analysis.pure)
exe = EXE(
    pyz,
    analysis.scripts,
    [],
    exclude_binaries=True,
    name="paperforge-worker",
    debug=False,
    strip=False,
    upx=False,
    console=True,  # stdio is the protocol. The host starts it with a hidden window.
)
coll = COLLECT(
    exe,
    analysis.binaries,
    analysis.datas,
    strip=False,
    upx=False,
    name="paperforge-worker",
)
