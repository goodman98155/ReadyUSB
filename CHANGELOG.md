# Changelog

ReadyUSB uses [semantic versioning](https://semver.org/). The version lives in `viewer/app.js`
(`VERSION`) and is shown in the page footer.

## 0.3.0 (2026-10-17)

- **Books and documents open in their own tab** in Chrome and Edge, so the library stays open.
  Firefox and Safari keep using one tab, because they'd ask for the folder again in every new tab.
- **"Back to library" button** at the top left of every book and document, filled so it's easy to
  find. In a tab opened from the library, it closes the tab and returns you to the library.
- Tabs keep their document lists in step: a document removed in one tab disappears from the others.
- **Search is hidden for now** until searching inside books is ready. Title search can be turned
  back on in `viewer/app.js` (`SHOW_SEARCH`).
- Shorter, simpler setup instructions in README.txt.

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
