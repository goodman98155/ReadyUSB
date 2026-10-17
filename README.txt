READYUSB  (version 0.2.0)
=========================
Your offline library: trusted reference books that work without internet.

FOR READERS
-----------
1. Double-click "START HERE.html". It opens in your web browser.
2. The first time, click "Open my library" and choose this drive, or the
   folder named "library" on it.
3. Click a book or document, or type what you need in the search box.

Your own documents: click "Add documents" to put your own PDFs, pictures and
manuals on the drive (Chrome or Edge). In Firefox or Safari, copy them into the
"library\documents" folder with File Explorer or Finder. They show under "My documents".

No internet and no installing needed. Nothing you read or search leaves the computer.
Best in Chrome or Edge (they remember the folder). Firefox and Safari also work,
but ask you to choose the folder each time you open the library.


FOR WHOEVER BUILDS THE DISK
---------------------------
Folder layout (keep it together):

    START HERE.html     <- the only file readers open
    README.txt          <- this file
    library\            <- readers can choose this folder or the whole drive
        zims\           <- put .zim files here
        documents\      <- the reader's own files (PDFs, pictures, manuals)
    viewer\             <- the reader program (don't change, except config.js)

Adding books:   copy .zim files into the "library\zims" folder. That's it.
Removing books: delete the .zim file.
Adding documents: copy files into the "library\documents" folder. Folders
                  inside it show as groups, for example library\documents\Medical.
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
  - Personal documents: PDFs, pictures, text files, videos and sound recordings
    open in the library. Word, Excel and other files can be saved and opened
    with their own program. Search finds documents by name.

Not yet supported:
  - Full-text search (searching inside articles or documents, not just titles)
  - Very old .zim files that use XZ compression (most made before 2021).
    These show "Can't open" on the shelf. Download a newer version of that book.
  - Videos inside books may be slow to load

Renaming the library on your drive: the title in viewer\config.js can be anything,
for example "The Smith Family ReadyUSB".

License: MIT (see viewer\LICENSE.txt). Free to copy and share.
