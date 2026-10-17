READYUSB  (version 0.1)
=======================
Your offline library: trusted reference books that work without internet.

FOR READERS
-----------
1. Double-click "START HERE.html". It opens in your web browser.
2. The first time, click "Open my library" and choose the folder named "zims".
3. Click a book, or type what you need in the search box.

No internet and no installing needed. Nothing you read or search leaves the computer.
Best in Chrome or Edge (they remember the folder). Firefox and Safari also work,
but ask you to choose the folder each time you open the library.


FOR WHOEVER BUILDS THE DISK
---------------------------
Folder layout (keep it together):

    START HERE.html     <- the only file readers open
    README.txt          <- this file
    zims\               <- put .zim files here
    viewer\             <- the reader program (don't change, except config.js)

Adding books:   copy .zim files into the "zims" folder. That's it.
Removing books: delete the .zim file.
Renaming the library: open viewer\config.js in Notepad and change the title.

Where to get books: https://library.kiwix.org  (download on any internet-connected computer)
Recommended starting points:
  - wikipedia_en_medicine_maxi   (medical encyclopedia, with pictures)
  - wikipedia_en_all_nopic       (all of English Wikipedia, text only)
  - ifixit, wikihow, and other practical guides

What works in this version:
  - Wikipedia-style books (static pages), including pictures
  - Many website copies (marked "Website copy"; some pages may look different)
  - Title search across all books at once

Not yet supported:
  - Full-text search (searching inside articles, not just titles)
  - Very old .zim files that use XZ compression (most made before 2021).
    These show "Can't open" on the shelf. Download a newer version of that book.
  - Videos inside books may be slow to load

Renaming the library on your drive: the title in viewer\config.js can be anything,
for example "The Smith Family ReadyUSB".

License: MIT (see viewer\LICENSE.txt). Free to copy and share.
