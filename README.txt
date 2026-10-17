READYUSB  (version 0.3.0)
=========================
Your offline library: trusted reference books that work without internet.


FOR READERS
-----------
1. Double-click "START HERE.html". It opens in your web browser.
2. The first time, click "Open my library" and choose this drive, or the
   folder named "library" on it.
3. Click a book or document to open it.
   In Chrome and Edge, each one opens in its own tab. Click "Back to library"
   at the top left to return.

Your own documents: in Chrome or Edge, click "Add documents". In other
browsers, copy your files into the "documents" folder inside "library".

No internet and no installing needed. Nothing you read leaves the computer.
Best in Chrome or Edge, which remember the folder. Firefox also works, but
asks you to choose the folder each time.


SETTING UP A READYUSB DRIVE
---------------------------
You need a USB drive with room for your books (128 GB or more is a good
size), the ReadyUSB zip file, and internet for the downloads.

1. Unzip the ReadyUSB zip file.
2. Copy everything inside it onto the USB drive: START HERE.html, README.txt
   and the "library" and "viewer" folders. Keep them together.
3. Download books from https://library.kiwix.org (they are ".zim" files) and
   copy them into the "zims" folder inside "library" on the drive.
   Good ones to start with:
     - wikipedia_en_medicine_maxi   (medical encyclopedia, with pictures)
     - wikipedia_en_all_nopic       (all of English Wikipedia, text only)
     - ifixit, wikihow, and other practical guides
4. Optional: copy your own PDFs, pictures and manuals into the "documents"
   folder inside "library". Folders you make in there show up as groups.
5. Double-click "START HERE.html" on the drive to try it.

If a big book won't copy because it's "too large", the drive is formatted as
FAT32, which can't hold files over 4 GB. Reformat it as exFAT (this erases
the drive), or use a drive that's already exFAT.


ADDING, REMOVING AND RENAMING
-----------------------------
    START HERE.html     <- the only file readers open
    README.txt          <- this file
    library             <- readers can choose this folder or the whole drive
        zims            <- .zim book files
        documents       <- the reader's own files
    viewer              <- the reader program (don't change, except config.js)

Books:     add or delete .zim files in "zims".
Documents: add or delete files in "documents", or use "Add documents" and
           "Remove" in Chrome or Edge.
Library name: open viewer/config.js in a text editor and change the title,
           for example "The Smith Family ReadyUSB". Keep the quotes.


WHAT WORKS IN THIS VERSION
--------------------------
  - Wikipedia-style books, including pictures
  - Many website copies (marked "Website copy"; some pages may look different)
  - Your own documents: PDFs, pictures, text, video and sound open in the
    library; Word, Excel and other files can be saved and opened elsewhere

Not yet supported:
  - Search (coming in a later version)
  - Very old .zim files (most made before 2021) show "Can't open".
    Download a newer version of that book.


License: MIT (see viewer/LICENSE.txt). Free to copy and share.
