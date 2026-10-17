# Changelog

ReadyUSB uses [semantic versioning](https://semver.org/). The version lives in `viewer/app.js`
(`VERSION`) and is shown in the page footer.

## 0.2.0 (2026-10-17)

- **My documents.** Keep your own PDFs, pictures, manuals and other files on the drive, next to the
  books. Subfolders show as groups, and search finds documents by name.
  - PDFs open in the browser's PDF viewer; pictures, text, CSV, web pages, video and sound open in
    the reader; Word, Excel and other files offer "Save a copy".
  - Chrome and Edge can add and remove documents from the page. Firefox and Safari explain how to
    copy them into the `library\documents` folder.
- **New drive layout.** Books and documents live in `library\zims` and `library\documents`. Readers
  can choose either the drive or the `library` folder. Drives with the old layout still work.
- **Friendlier return visits.** Chrome and Edge show your shelf with a slim "Welcome back" bar.
  Firefox and Safari show only the "Open my library" card until the drive is chosen.
- **New logo** ("Lantern + Plug") for the favicon and the library title.
- Search box now says "Search your books and documents".
- The version number is shown in the page footer.

## 0.1.0 (2026-10-17)

- First version: open Kiwix `.zim` books from a USB drive with no install, server or internet.
- Bookshelf, title search across all books, Wikipedia-style pages with pictures, website copies.
- Chrome and Edge remember the folder; Firefox and Safari ask for it on each visit.
