# Implementation checklist

## Done and verified by tests or by driving the app

- [x] Import, thumbnails, preview, assembly, reorder, rotate, duplicate, blank pages, undo and redo
- [x] Export with page sizing, image fit and page numbers, reopened and verified
- [x] Merge through the assembly engine
- [x] Split and extract, all four modes, with expected outputs shown first
- [x] Compress: lossless, balanced, stronger, labelled rasterise
- [x] PDF to images, images to PDF
- [x] Page numbers and watermarks with live previews
- [x] Password protection and authorised removal, permission flags respected
- [x] Text extraction and document metadata
- [x] Visual signatures and text annotations, with placement checked on rotated and cropped pages
- [x] Jobs: bounded queue, progress, confirmed cancellation, temp cleanup
- [x] Security: sandbox, CSP, navigation blocked, id-based file access
- [x] Settings, recent files off by default, dependency notices
- [x] Windows installer and portable build

## Implemented, but not exercised by automated tests

- [ ] A physical drag from Explorer. The drop path is tested with real File objects and a synthetic drop event.
- [ ] Hot reload in dev mode. Start-up in dev mode was checked.
- [ ] Very large documents (thousands of pages, hundreds of MB)
- [ ] The NSIS setup wizard. Silent install, uninstall and reinstall were run by hand on Windows 11, and the installed app passes `npm run test:packaged`.

## Not implemented

- [ ] OCR (optional extra, see roadmap)
- [ ] Saved assembly projects, batch presets, bookmark editing, PDF comparison, CLI (optional extras)
- [ ] Redaction (deliberately not offered)
- [ ] Code signing
