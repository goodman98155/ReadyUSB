/*
 * ReadyUSB — app.js
 * Library shelf, folder access, search and the article reader.
 * Plain browser JavaScript: no build step, no server, no internet.
 * Part of ReadyUSB. MIT License — see viewer/LICENSE.txt
 */
(function () {
  'use strict';

  // Release version: shown in the page footer. Keep README.txt and CHANGELOG.md in step
  // (tools/make-release.ps1 checks this).
  var VERSION = '0.3.0';

  // Title search is hidden until full-text search is ready; the code stays. true shows both search boxes.
  var SHOW_SEARCH = false;

  var CONFIG = window.LIBRARY_CONFIG || {};
  var CACHE_KEY = 'readyusb.shelf.v1';
  var TEXT_KEY = 'readyusb.textScale';
  var DB_NAME = 'readyusb';
  var LINK_BASE = 'http://zim.invalid/';
  var MAX_SCAN_DEPTH = 4;   // drive / library / zims / two levels of subfolders
  var supportsFolderMemory = typeof window.showDirectoryPicker === 'function';

  var state = {
    books: [],            // {id, file?, info, archive?, error?}
    byId: {},
    docs: [],             // {id, file, info, handle?, dir?}  (handle/dir only with folder memory)
    docById: {},
    libraryRoot: false,   // true when the drive or its library folder was chosen, not just the book folder
    libraryDir: null,     // handle of the library folder (holds zims/ and documents/), with folder memory
    connected: false,
    dirHandle: null,
    route: null,
    current: null,        // {book, entry, path}
    navToken: 0,
    blobUrls: [],
    textScale: 1,
    pendingRoute: null
  };

  var $ = function (id) { return document.getElementById(id); };

  // ---------------------------------------------------------------- utilities

  function lsGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) { /* storage unavailable */ } }

  function idb(mode, fn) {
    return new Promise(function (resolve, reject) {
      var req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () { req.result.createObjectStore('kv'); };
      req.onerror = function () { reject(req.error); };
      req.onsuccess = function () {
        var db = req.result;
        try {
          var tx = db.transaction('kv', mode);
          var r = fn(tx.objectStore('kv'));
          tx.oncomplete = function () { db.close(); resolve(r && r.result); };
          tx.onerror = function () { db.close(); reject(tx.error); };
        } catch (e) { db.close(); reject(e); }
      };
    });
  }
  function idbGet(key) { return idb('readonly', function (s) { return s.get(key); }).catch(function () { return null; }); }
  function idbSet(key, val) { return idb('readwrite', function (s) { s.put(val, key); }).catch(function () { }); }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function baseMime(m) { return String(m || 'application/octet-stream').split(';')[0].trim(); }

  function formatSize(bytes) {
    if (!bytes) return '';
    var u = ['bytes', 'KB', 'MB', 'GB', 'TB'], i = 0;
    while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
    return (bytes >= 10 || i === 0 ? Math.round(bytes) : bytes.toFixed(1)) + ' ' + u[i];
  }
  function formatDate(d) {
    var m = /^(\d{4})-(\d{2})/.exec(d || '');
    if (!m) return '';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return months[parseInt(m[2], 10) - 1] + ' ' + m[1];
  }
  var LANGS = { eng: 'English', spa: 'Español', fra: 'Français', deu: 'Deutsch', por: 'Português', ita: 'Italiano',
    rus: 'Русский', zho: '中文', jpn: '日本語', ara: 'العربية', hin: 'हिन्दी', nld: 'Nederlands', pol: 'Polski',
    tha: 'ไทย', vie: 'Tiếng Việt', kor: '한국어', tur: 'Türkçe', ukr: 'Українська', swe: 'Svenska', fas: 'فارسی' };
  function formatLanguage(code) {
    if (!code) return '';
    var first = code.split(',')[0].trim();
    return LANGS[first] || first.toUpperCase();
  }

  // kind decides how a document is shown: pdf (browser viewer), image/text/html/video/audio (in the page
  // frame), or file (offered as a download only).
  var DOC_TYPES = {
    pdf: { kind: 'pdf', label: 'PDF', mime: 'application/pdf' },
    png: { kind: 'image', label: 'Picture', mime: 'image/png' },
    jpg: { kind: 'image', label: 'Picture', mime: 'image/jpeg' },
    jpeg: { kind: 'image', label: 'Picture', mime: 'image/jpeg' },
    gif: { kind: 'image', label: 'Picture', mime: 'image/gif' },
    webp: { kind: 'image', label: 'Picture', mime: 'image/webp' },
    bmp: { kind: 'image', label: 'Picture', mime: 'image/bmp' },
    svg: { kind: 'image', label: 'Picture', mime: 'image/svg+xml' },
    txt: { kind: 'text', label: 'Text', mime: 'text/plain' },
    md: { kind: 'text', label: 'Text', mime: 'text/plain' },
    log: { kind: 'text', label: 'Text', mime: 'text/plain' },
    csv: { kind: 'text', label: 'Spreadsheet (CSV)', mime: 'text/plain' },
    html: { kind: 'html', label: 'Web page', mime: 'text/html' },
    htm: { kind: 'html', label: 'Web page', mime: 'text/html' },
    mp4: { kind: 'video', label: 'Video', mime: 'video/mp4' },
    m4v: { kind: 'video', label: 'Video', mime: 'video/mp4' },
    webm: { kind: 'video', label: 'Video', mime: 'video/webm' },
    mp3: { kind: 'audio', label: 'Sound recording', mime: 'audio/mpeg' },
    m4a: { kind: 'audio', label: 'Sound recording', mime: 'audio/mp4' },
    wav: { kind: 'audio', label: 'Sound recording', mime: 'audio/wav' },
    ogg: { kind: 'audio', label: 'Sound recording', mime: 'audio/ogg' },
    doc: { kind: 'file', label: 'Word document' },
    docx: { kind: 'file', label: 'Word document' },
    odt: { kind: 'file', label: 'Document' },
    rtf: { kind: 'file', label: 'Document' },
    xls: { kind: 'file', label: 'Spreadsheet' },
    xlsx: { kind: 'file', label: 'Spreadsheet' },
    ods: { kind: 'file', label: 'Spreadsheet' },
    ppt: { kind: 'file', label: 'Slides' },
    pptx: { kind: 'file', label: 'Slides' },
    odp: { kind: 'file', label: 'Slides' },
    zip: { kind: 'file', label: 'Zip file' }
  };
  function docType(info) {
    return DOC_TYPES[info.ext] || { kind: 'file', label: info.ext ? info.ext.toUpperCase() + ' file' : 'File' };
  }

  function bytesToDataUrl(mime, bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return 'data:' + baseMime(mime) + ';base64,' + btoa(bin);
  }

  var toastTimer;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 4000);
  }

  function friendlyError(err) {
    var code = err && err.code;
    var name = err && err.name;
    if (code === 'OLD_FORMAT') return 'This book uses an older format this library can\'t open yet.';
    if (code === 'NOT_ZIM') return 'This file isn\'t a readable book (it may be damaged or not a .zim file).';
    if (code === 'DAMAGED') return 'This book file seems to be damaged.';
    if (name === 'NotReadableError' || name === 'NotFoundError') return 'The book couldn\'t be read. Is the drive still plugged in?';
    return 'Something went wrong opening this book.';
  }

  function writeErrorText(err) {
    if (err && err.userMessage) return err.userMessage;
    var name = err && err.name;
    if (name === 'QuotaExceededError') return 'The drive is full. Remove something from it, then try again.';
    if (name === 'NoModificationAllowedError' || name === 'InvalidModificationError') return 'This drive can\'t be changed. It may be locked (read-only).';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'The library wasn\'t allowed to change files on this drive.';
    if (name === 'NotFoundError' || name === 'NotReadableError') return 'The drive couldn\'t be reached. Is it still plugged in?';
    return 'Something went wrong saving to the drive.';
  }

  // ---------------------------------------------------------------- config text

  function applyConfig() {
    document.querySelectorAll('[data-config]').forEach(function (el) {
      var v = CONFIG[el.getAttribute('data-config')];
      if (v) el.textContent = v;
    });
    var folder = CONFIG.zimFolderName || 'zims';
    document.querySelectorAll('.zim-folder-name').forEach(function (el) { el.textContent = folder; });
    document.querySelectorAll('.docs-folder-name').forEach(function (el) { el.textContent = docsFolder(); });
    document.querySelectorAll('.library-folder-name').forEach(function (el) { el.textContent = libraryFolder(); });
    if (CONFIG.title) document.title = CONFIG.title;
    $('appVersion').textContent = VERSION;
  }

  // ---------------------------------------------------------------- book access

  function bookIcon(info, extraClass) {
    var cls = 'book-icon' + (extraClass ? ' ' + extraClass : '');
    if (info && info.icon) return '<span class="' + cls + '"><img src="' + info.icon + '" alt=""></span>';
    var letter = ((info && info.title) || '?').trim().charAt(0).toUpperCase();
    return '<span class="' + cls + ' book-icon-letter" aria-hidden="true">' + escapeHtml(letter) + '</span>';
  }

  function getArchive(book) {
    if (!book.file) return Promise.reject(Object.assign(new Error('not connected'), { code: 'NOT_CONNECTED' }));
    if (!book.archivePromise) {
      book.archivePromise = new Zim.Archive(book.file, book.file.name).open().then(function (a) {
        a.isWebsiteCopy = !!(book.info && book.info.isWebsiteCopy);
        return a;
      });
      book.archivePromise.catch(function () { book.archivePromise = null; });
    }
    return book.archivePromise;
  }

  async function describeFile(file, id, cached) {
    if (cached && cached.size === file.size && cached.lastModified === file.lastModified && !cached.error) {
      return { id: id, file: file, info: cached };
    }
    var info = { id: id, name: file.name, size: file.size, lastModified: file.lastModified };
    var book = { id: id, file: file, info: info };
    try {
      var a = await getArchive(book);
      var d = await a.describe();
      Object.assign(info, d);
      var icon = await a.getIllustration().catch(function () { return null; });
      if (icon && icon.data.length > 200 && icon.data.length < 60000) info.icon = bytesToDataUrl(icon.mimeType, icon.data);
      if (d.mainPath) {
        // Make sure the front page can actually be read (catches unsupported compression early).
        var main = await a.findPath(d.mainPath);
        if (main) await a.getContent(main);
      }
      a.isWebsiteCopy = !!d.isWebsiteCopy;
    } catch (err) {
      info.title = info.title || file.name.replace(/\.zim$/i, '');
      info.error = friendlyError(err);
      console.warn('Could not open', file.name, err);
    }
    return book;
  }

  function libraryFolder() { return CONFIG.libraryFolderName || 'library'; }
  function docsFolder() { return CONFIG.documentsFolderName || 'documents'; }

  /** Path inside the documents folder ("Medical/plan.pdf"), or null when the file isn't in it. */
  function docRelPath(p) {
    var folder = docsFolder().toLowerCase() + '/';
    var i = ('/' + p.toLowerCase()).indexOf('/' + folder);
    return i < 0 ? null : p.slice(i + folder.length);
  }

  /** Skips hidden files, Office lock files, Windows clutter and our own placeholder note. */
  function isDocName(name) {
    return !/^(\.|~\$)/.test(name) && !/^(thumbs\.db|desktop\.ini)$/i.test(name) &&
      !/^PUT-.*-HERE\.txt$/i.test(name) && !/\.zim$/i.test(name);
  }

  function makeDoc(entry, rel) {
    var name = rel.split('/').pop();
    var dot = name.lastIndexOf('.');
    var slash = rel.lastIndexOf('/');
    return {
      id: rel, file: entry.file, handle: entry.handle || null, dir: entry.dir || null,
      info: {
        id: rel, name: name,
        title: dot > 0 ? name.slice(0, dot) : name,
        ext: dot > 0 ? name.slice(dot + 1).toLowerCase() : '',
        group: slash >= 0 ? rel.slice(0, slash) : '',
        size: entry.file.size, lastModified: entry.file.lastModified
      }
    };
  }

  function setDocs(docs) {
    docs.sort(function (a, b) {
      return a.info.group.localeCompare(b.info.group) || a.info.title.localeCompare(b.info.title);
    });
    state.docs = docs;
    state.docById = {};
    docs.forEach(function (d) { d.info.kind = docType(d.info).kind; state.docById[d.id] = d; });
  }

  function saveShelfCache() {
    lsSet(CACHE_KEY, {
      books: state.books.map(function (b) { return b.info; }),
      docs: state.docs.map(function (d) { return d.info; }),
      savedAt: Date.now()
    });
  }

  /**
   * entries: [{file, path, handle?, dir?}] from a folder scan or a file picker.
   * opts.libraryRoot: the drive or its library folder was chosen. opts.keepDocs: only books changed (a drop).
   */
  async function loadFiles(entries, opts) {
    opts = opts || {};
    var zims = [], docs = [];
    entries.forEach(function (e) {
      if (/\.zim$/i.test(e.file.name)) {
        // Paths relative to the "zims" folder, so ids stay the same whichever folder was chosen.
        zims.push({ file: e.file, path: stripZimFolder(e.path) });
        return;
      }
      var rel = docRelPath(e.path);
      if (rel && isDocName(e.file.name)) docs.push(makeDoc(e, rel));
    });
    if (!zims.length && !docs.length && !opts.libraryRoot) {
      showLibraryMessage('Nothing found there',
        'We couldn\'t find any books or documents in that folder. Try again and choose this drive, or the folder named ' +
        '<strong>' + escapeHtml(libraryFolder()) + '</strong> on it.', true);
      return false;
    }
    showLibraryMessage(null);
    if (zims.length) setLoading(true, 'Opening ' + zims.length + (zims.length === 1 ? ' book…' : ' books…'));
    var cache = lsGet(CACHE_KEY) || { books: [] };
    var cachedById = {};
    (cache.books || []).forEach(function (b) { cachedById[b.id] = b; });
    var books = await Promise.all(zims.map(function (z) { return describeFile(z.file, z.path, cachedById[z.path]); }));
    books.sort(function (a, b) { return a.info.title.localeCompare(b.info.title); });
    state.books = books;
    state.byId = {};
    books.forEach(function (b) { state.byId[b.id] = b; });
    if (!opts.keepDocs) {
      setDocs(docs);
      state.libraryRoot = !!opts.libraryRoot || docs.length > 0;
    }
    state.connected = true;
    saveShelfCache();
    setLoading(false);
    renderShelf();
    if (state.pendingRoute) { var r = state.pendingRoute; state.pendingRoute = null; route(r); }
    else route();
    return true;
  }

  async function scanDirectory(dir, prefix, depth, out) {
    for await (var pair of dir.entries()) {
      var name = pair[0], handle = pair[1], path = prefix + name;
      if (handle.kind === 'file') {
        if (/\.zim$/i.test(name) || (docRelPath(path) !== null && isDocName(name))) {
          out.push({ file: await handle.getFile(), path: path, handle: handle, dir: dir });
        }
      } else if (depth < MAX_SCAN_DEPTH && !/^(\$RECYCLE\.BIN|System Volume Information|\.)/i.test(name)) {
        try { await scanDirectory(handle, path + '/', depth + 1, out); } catch (e) { /* skip unreadable folder */ }
      }
    }
    return out;
  }

  /** True when the chosen folder is the drive (START HERE.html, library) or the library folder (zims, documents). */
  async function isLibraryRoot(handle) {
    var tries = [
      function () { return handle.getFileHandle('START HERE.html'); },
      function () { return handle.getDirectoryHandle(libraryFolder()); },
      function () { return handle.getDirectoryHandle(CONFIG.zimFolderName || 'zims'); },
      function () { return handle.getDirectoryHandle(docsFolder()); }
    ];
    for (var i = 0; i < tries.length; i++) {
      try { await tries[i](); return true; } catch (e) { /* not here */ }
    }
    return false;
  }

  /** Same test for the fallback picker, where paths start with the chosen folder's name. */
  function isLibraryPick(entries) {
    var names = ['start here.html', libraryFolder().toLowerCase(), (CONFIG.zimFolderName || 'zims').toLowerCase(), docsFolder().toLowerCase()];
    return entries.some(function (e) {
      var parts = e.path.toLowerCase().split('/');
      return parts.length > 1 && names.indexOf(parts[1]) >= 0;
    });
  }

  /** The library folder: "library" on the drive when the drive was chosen, else the chosen folder itself. */
  async function findLibraryDir(handle) {
    try { return await handle.getDirectoryHandle(libraryFolder()); } catch (e) { return handle; }
  }

  async function connectHandle(handle) {
    state.dirHandle = handle;
    setLoading(true, 'Looking for books and documents…');
    try {
      state.libraryDir = await findLibraryDir(handle);
      var found = await scanDirectory(handle, '', 0, []);
      return await loadFiles(found, { libraryRoot: await isLibraryRoot(handle) });
    } catch (err) {
      setLoading(false);
      showLibraryMessage('Couldn\'t open that folder', escapeHtml(friendlyError(err)), true);
      return false;
    }
  }

  function stripZimFolder(p) {
    var folder = (CONFIG.zimFolderName || 'zims') + '/';
    var i = p.toLowerCase().indexOf(folder.toLowerCase());
    return i >= 0 ? p.slice(i + folder.length) : p;
  }

  /** Must be called from a click (browsers only allow file access after a user action). */
  async function openLibrary() {
    if (supportsFolderMemory) {
      try {
        if (state.dirHandle) {
          var perm = await state.dirHandle.requestPermission({ mode: 'read' });
          if (perm === 'granted') return connectHandle(state.dirHandle);
        }
        var handle = await window.showDirectoryPicker({ id: 'readyusb-library', mode: 'read' });
        await idbSet('libraryFolder', handle);
        return connectHandle(handle);
      } catch (err) {
        if (err && err.name === 'AbortError') return false; // user cancelled
        console.warn('Folder picker unavailable, using fallback', err);
      }
    }
    $('folderInput').value = '';
    $('folderInput').click();
    return false;
  }

  function filesFromInput(input) {
    return Array.prototype.map.call(input.files, function (f) {
      return { file: f, path: f.webkitRelativePath || f.name };
    });
  }

  // ---------------------------------------------------------------- personal documents

  /** Adding and removing documents needs the remembered folder (Chrome/Edge) and the whole drive. */
  function canChangeDocs() {
    return supportsFolderMemory && state.connected && !!state.dirHandle && state.libraryRoot;
  }

  async function ensureWritable() {
    var h = state.dirHandle;
    try {
      if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
      return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
    } catch (e) { return false; }
  }

  function needWriteError() {
    return Object.assign(new Error('no write permission'), {
      userMessage: 'The library needs your permission to save to this drive. Try again and choose Allow (or Edit files).'
    });
  }

  /**
   * Reads the documents folder again after something was added or removed. fromOtherTab: another tab
   * changed it; don't write the cache back, or the tabs would keep refreshing each other.
   */
  async function refreshDocs(fromOtherTab) {
    var found = [];
    try {
      var dir = await state.libraryDir.getDirectoryHandle(docsFolder());
      // Same depth limit as the first scan, which started at the chosen folder.
      await scanDirectory(dir, docsFolder() + '/', state.libraryDir === state.dirHandle ? 1 : 2, found);
    } catch (e) { /* no documents folder yet */ }
    setDocs(found.filter(function (e) { return !/\.zim$/i.test(e.file.name); })
      .map(function (e) { return makeDoc(e, docRelPath(e.path)); }));
    if (!fromOtherTab) saveShelfCache();
    renderShelf();
  }

  function docGroups() {
    var seen = {};
    state.docs.forEach(function (d) { if (d.info.group) seen[d.info.group] = true; });
    return Object.keys(seen).sort(function (a, b) { return a.localeCompare(b); });
  }
  function groupLabel(g) { return g.split('/').join(' › '); }

  function cleanGroupName(s) {
    return String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 60).trim();
  }

  /** "plan.pdf" → "plan (2).pdf" when a file with that name is already there. */
  async function freeName(dir, name) {
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (var n = 1; n < 100; n++) {
      var candidate = n === 1 ? name : stem + ' (' + n + ')' + ext;
      try { await dir.getFileHandle(candidate); } catch (e) { return candidate; }
    }
    return stem + ' (' + Date.now() + ')' + ext;
  }

  async function saveDocuments(files, group) {
    if (!(await ensureWritable())) throw needWriteError();
    var dir = await state.libraryDir.getDirectoryHandle(docsFolder(), { create: true });
    var parts = group ? group.split('/') : [];
    for (var i = 0; i < parts.length; i++) dir = await dir.getDirectoryHandle(parts[i], { create: true });
    for (var j = 0; j < files.length; j++) {
      var fh = await dir.getFileHandle(await freeName(dir, files[j].name), { create: true });
      var w = await fh.createWritable();
      try { await w.write(files[j]); await w.close(); }
      catch (err) { try { await w.abort(); } catch (e) { /* ignore */ } throw err; }
    }
    await refreshDocs();
    toast(files.length === 1 ? 'Added “' + files[0].name + '” to the drive.' : 'Added ' + files.length + ' documents to the drive.');
  }

  /** Must be called from a click: the file picker needs a user action. */
  async function addDocuments() {
    if (!canChangeDocs()) { showAddHelp(); return; }
    var handles;
    try { handles = await window.showOpenFilePicker({ multiple: true, id: 'readyusb-add' }); }
    catch (err) {
      if (err && err.name === 'AbortError') return;
      console.warn('File picker failed', err);
      showAddHelp();
      return;
    }
    askWhereToSave(await Promise.all(handles.map(function (h) { return h.getFile(); })));
  }

  function askWhereToSave(files) {
    if (!files.length) return;
    var shown = files.slice(0, 6).map(function (f) { return '<li>' + escapeHtml(f.name) + '</li>'; }).join('');
    if (files.length > 6) shown += '<li>…and ' + (files.length - 6) + ' more</li>';
    var groups = docGroups();
    var html = '<ul class="dialog-files">' + shown + '</ul>' +
      '<label class="field-label" for="groupSelect">Put ' + (files.length === 1 ? 'it' : 'them') + ' in a group <span>(optional)</span></label>' +
      '<select id="groupSelect" class="field">' +
        '<option value="">No group</option>' +
        groups.map(function (g) { return '<option value="' + escapeHtml(g) + '">' + escapeHtml(groupLabel(g)) + '</option>'; }).join('') +
        '<option value="__new">New group…</option>' +
      '</select>' +
      '<input id="newGroupInput" class="field" type="text" maxlength="60" placeholder="Group name, like Medical or House" hidden>';
    openDialog({
      title: files.length === 1 ? 'Add 1 document' : 'Add ' + files.length + ' documents',
      html: html,
      actions: [
        { label: 'Cancel', kind: 'link' },
        {
          label: 'Add to drive', busyLabel: 'Saving…', kind: 'primary',
          run: function () {
            var sel = $('groupSelect').value;
            var group = sel === '__new' ? cleanGroupName($('newGroupInput').value) : sel;
            if (sel === '__new' && !group) {
              return Promise.reject(Object.assign(new Error('no group name'), { userMessage: 'Type a name for the new group, or choose No group.' }));
            }
            return saveDocuments(files, group);
          }
        }
      ]
    });
    $('groupSelect').addEventListener('change', function () {
      var isNew = this.value === '__new';
      $('newGroupInput').hidden = !isNew;
      if (isNew) $('newGroupInput').focus();
    });
  }

  function showAddHelp() {
    if (!state.libraryRoot) {
      openDialog({
        title: 'Choose the drive first',
        html: '<p>Right now the library is reading only the <strong>' + escapeHtml(CONFIG.zimFolderName || 'zims') +
          '</strong> folder. To keep your own documents here, choose this drive, or the folder named <strong>' +
          escapeHtml(libraryFolder()) + '</strong> on it.</p>',
        actions: [
          { label: 'Cancel', kind: 'link' },
          { label: 'Choose the drive', kind: 'primary', run: function () { state.dirHandle = null; openLibrary(); } }
        ]
      });
      return;
    }
    var ua = navigator.userAgent;
    var browser = /Firefox\//.test(ua) ? 'Firefox' : (/Safari\//.test(ua) && !/Chrome|Chromium|Edg\//.test(ua) ? 'Safari' : 'This browser');
    openDialog({
      title: 'Add your own documents',
      html: '<p><strong>' + browser + ' can\'t save files to this drive</strong>, so this button can\'t add them for you. ' +
        'You can copy them in yourself instead:</p>' +
        '<ol class="steps">' +
          '<li>Open this drive in File Explorer (on a Mac, Finder).</li>' +
          '<li>Open the <strong>' + escapeHtml(libraryFolder()) + '</strong> folder, then the <strong>' + escapeHtml(docsFolder()) + '</strong> folder inside it.</li>' +
          '<li>Copy your files into it. You can make folders inside it to group them, like “Medical”.</li>' +
          '<li>Come back here and click <strong>Open my library again</strong>.</li>' +
        '</ol>' +
        (supportsFolderMemory ? '' : '<p class="dialog-tip">Or open this library in Chrome or Edge, where you can add documents right from this page.</p>'),
      actions: [
        { label: 'Close', kind: 'link' },
        { label: 'Open my library again', kind: 'primary', run: function () { openLibrary(); } }
      ]
    });
  }

  function showOpenHelp() {
    openDialog({
      title: 'Opening your library',
      html: '<p>Your browser asks once each visit before it shows the books and documents on this drive.</p>' +
        '<ol class="steps">' +
          '<li>Click <strong>Open my library</strong>.</li>' +
          '<li>Choose this drive, or the folder named <strong>' + escapeHtml(libraryFolder()) + '</strong> on it.</li>' +
          '<li>Click <strong>Select Folder</strong> (or <strong>Upload</strong>, <strong>Open</strong>, or <strong>View files</strong>).</li>' +
        '</ol>' +
        '<p class="dialog-tip">If your browser asks to “upload” or “view” files, that\'s normal. Nothing leaves this computer, and no internet is needed.</p>',
      actions: [
        { label: 'Close', kind: 'link' },
        { label: 'Open my library', kind: 'primary', run: function () { openLibrary(); } }
      ]
    });
  }

  function confirmRemove() {
    var doc = state.current && state.current.doc;
    if (!doc || !doc.dir) return;
    openDialog({
      title: 'Remove this document?',
      html: '<p><strong>' + escapeHtml(doc.info.name) + '</strong> will be deleted from this drive. This can\'t be undone.</p>',
      actions: [
        { label: 'Keep it', kind: 'link' },
        {
          label: 'Remove from drive', busyLabel: 'Removing…', kind: 'danger',
          run: async function () {
            if (!(await ensureWritable())) throw needWriteError();
            await doc.dir.removeEntry(doc.handle.name);
            await refreshDocs();
            toast('Removed “' + doc.info.name + '” from the drive.');
            backToLibrary();
          }
        }
      ]
    });
  }

  // ---------------------------------------------------------------- dialog

  /** opts: {title, html, actions: [{label, kind: 'primary'|'danger'|'link', busyLabel?, run?}]} */
  function openDialog(opts) {
    var d = $('dialog');
    d.innerHTML = '<div class="dialog-body"><h2>' + escapeHtml(opts.title) + '</h2>' + (opts.html || '') +
      '<p class="dialog-error" role="alert" hidden></p><div class="dialog-actions"></div></div>';
    var bar = d.querySelector('.dialog-actions');
    var busy = false;
    d.oncancel = function (ev) { if (busy) ev.preventDefault(); };
    opts.actions.forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = a.kind === 'link' ? 'link-button' : 'primary-button small' + (a.kind === 'danger' ? ' danger' : '');
      b.textContent = a.label;
      b.addEventListener('click', async function () {
        if (!a.run) { d.close(); return; }
        var errBox = d.querySelector('.dialog-error');
        var buttons = bar.querySelectorAll('button');
        errBox.hidden = true;
        busy = true;
        buttons.forEach(function (x) { x.disabled = true; });
        if (a.busyLabel) b.textContent = a.busyLabel;
        try {
          await a.run();
          d.close();
        } catch (err) {
          console.warn('Dialog action failed', err);
          errBox.textContent = writeErrorText(err);
          errBox.hidden = false;
          b.textContent = a.label;
        }
        busy = false;
        buttons.forEach(function (x) { x.disabled = false; });
      });
      bar.appendChild(b);
    });
    d.showModal();
    var first = d.querySelector('select, input:not([hidden]), .primary-button');
    if (first) first.focus();
  }

  // ---------------------------------------------------------------- library view

  function setLoading(on, text) {
    var m = $('libraryMessage');
    if (on) {
      m.className = 'message loading';
      m.innerHTML = '<span class="spinner" aria-hidden="true"></span><span>' + escapeHtml(text || 'Loading…') + '</span>';
      m.hidden = false;
    } else if (m.classList.contains('loading')) {
      m.hidden = true;
    }
  }

  function showLibraryMessage(title, html, isError) {
    var m = $('libraryMessage');
    if (!title) { m.hidden = true; return; }
    m.className = 'message' + (isError ? ' error' : '');
    m.innerHTML = '<strong>' + escapeHtml(title) + '</strong><span>' + html + '</span>';
    m.hidden = false;
  }

  function renderShelf() {
    // Without folder memory (Firefox/Safari) every visit needs a fresh folder pick, so a cached shelf
    // would only show books that can't be clicked yet. Those browsers see just the connect card.
    var cache = supportsFolderMemory ? lsGet(CACHE_KEY) : null;
    var infos = state.connected ? state.books.map(function (b) { return b.info; }) : ((cache && cache.books) || []);
    var shelf = $('shelf');
    $('shelfSection').hidden = !infos.length;
    $('shelfCount').textContent = infos.length ? infos.length + (infos.length === 1 ? ' book' : ' books') : '';
    $('changeFolderBtn').hidden = !state.connected;

    // First visit: the full card with steps. Returning visitors already see their shelf from the cache,
    // so they get one slim line instead, and the steps only on request.
    var returning = infos.length > 0 || !!(cache && cache.docs && cache.docs.length);
    $('connectCard').hidden = state.connected || returning;
    $('welcomeBar').hidden = state.connected || !returning;
    // With a remembered folder (Chrome/Edge) the browser only asks "Allow?"; no folder to choose.
    $('welcomeHelpBtn').hidden = !!state.dirHandle;
    renderDocs(cache);

    shelf.innerHTML = infos.map(function (info) {
      var meta = [];
      if (info.articleCount) meta.push(info.articleCount.toLocaleString() + ' articles');
      if (info.language) meta.push(formatLanguage(info.language));
      if (info.date) meta.push(formatDate(info.date));
      if (info.size) meta.push(formatSize(info.size));
      var badge = info.error ? '<span class="badge badge-error">Can\'t open</span>'
        : (info.isWebsiteCopy ? '<span class="badge" title="Copied from a website. Some pages may not look exactly like the original.">Website copy</span>' : '');
      if (badge) meta.unshift('');
      return '<button type="button" class="book-card' + (info.error ? ' is-error' : '') + (state.connected ? '' : ' is-waiting') +
        '" data-book="' + escapeHtml(info.id) + '">' +
        bookIcon(info) +
        '<span class="book-text">' +
          '<span class="book-title">' + escapeHtml(info.title) + '</span>' +
          (info.error ? '<span class="book-desc">' + escapeHtml(info.error) + '</span>'
                      : (info.description ? '<span class="book-desc">' + escapeHtml(info.description) + '</span>' : '')) +
          '<span class="book-meta">' + badge + escapeHtml(meta.filter(Boolean).join(' · ')) + '</span>' +
        '</span>' +
        '<svg class="book-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>' +
      '</button>';
    }).join('');
  }

  function docIcon(info, extraClass) {
    var label = (info.ext || 'file').slice(0, 4).toUpperCase();
    return '<span class="book-icon doc-icon kind-' + escapeHtml(info.kind || 'file') + (extraClass ? ' ' + extraClass : '') +
      '" aria-hidden="true">' + escapeHtml(label) + '</span>';
  }

  function docCard(info) {
    var meta = [docType(info).label, formatSize(info.size)];
    if (info.lastModified) meta.push(formatDate(new Date(info.lastModified).toISOString()));
    return '<button type="button" class="book-card doc-card' + (state.connected ? '' : ' is-waiting') +
      '" data-doc="' + escapeHtml(info.id) + '">' +
      docIcon(info) +
      '<span class="book-text">' +
        '<span class="book-title">' + escapeHtml(info.title) + '</span>' +
        '<span class="book-meta">' + escapeHtml(meta.filter(Boolean).join(' · ')) + '</span>' +
      '</span>' +
      '<svg class="book-arrow" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg>' +
    '</button>';
  }

  function renderDocs(cache) {
    var infos = state.connected ? state.docs.map(function (d) { return d.info; }) : ((cache && cache.docs) || []);
    $('docsSection').hidden = !state.connected && !infos.length;
    $('docsCount').textContent = infos.length ? infos.length + (infos.length === 1 ? ' document' : ' documents') : '';
    $('addDocsBtn').hidden = !state.connected || !state.libraryRoot;

    var empty = $('docsEmpty');
    empty.hidden = !(state.connected && !infos.length);
    if (!empty.hidden) {
      empty.innerHTML = state.libraryRoot
        ? '<strong>Keep your own papers here too.</strong>' +
          '<span>PDFs, pictures and manuals, like a medical plan, important phone numbers or insurance papers. ' +
          'They\'ll be on this drive next to your books, and they work without internet.</span>'
        : '<strong>Your own documents can live here too.</strong>' +
          '<span>Right now the library is reading only the book folder. To see your documents, choose this drive, ' +
          'or the folder named <strong>' + escapeHtml(libraryFolder()) + '</strong> on it.</span>' +
          '<button type="button" class="primary-button small" id="docsChooseDriveBtn">Choose the drive</button>';
    }

    // Documents in the top folder first, then one heading per group (subfolder).
    var byGroup = {}, order = [];
    infos.forEach(function (info) {
      var g = info.group || '';
      if (!byGroup[g]) { byGroup[g] = []; order.push(g); }
      byGroup[g].push(info);
    });
    order.sort(function (a, b) { return a === '' ? -1 : b === '' ? 1 : a.localeCompare(b); });
    $('docs').innerHTML = order.map(function (g) {
      return (g ? '<h3 class="doc-group">' + escapeHtml(groupLabel(g)) + '</h3>' : '') +
        '<div class="shelf">' + byGroup[g].map(docCard).join('') + '</div>';
    }).join('');
  }

  // ---------------------------------------------------------------- search

  var searchSeq = 0;

  function attachSearch(input, panel) {
    var timer = null, selected = -1;
    function close() { panel.hidden = true; selected = -1; }
    function items() { return panel.querySelectorAll('.result'); }
    function highlight(i) {
      var list = items();
      list.forEach(function (el, j) { el.classList.toggle('active', j === i); el.setAttribute('aria-selected', j === i); });
      if (list[i]) list[i].scrollIntoView({ block: 'nearest' });
      selected = i;
    }
    input.addEventListener('input', function () {
      clearTimeout(timer);
      var q = input.value.trim();
      if (q.length < 2) { close(); return; }
      timer = setTimeout(function () { runSearch(q, panel, close); selected = -1; }, 180);
    });
    input.addEventListener('keydown', function (ev) {
      var list = items();
      if (ev.key === 'ArrowDown') { ev.preventDefault(); if (panel.hidden && input.value.trim().length > 1) input.dispatchEvent(new Event('input')); highlight(Math.min(selected + 1, list.length - 1)); }
      else if (ev.key === 'ArrowUp') { ev.preventDefault(); highlight(Math.max(selected - 1, 0)); }
      else if (ev.key === 'Escape') { close(); }
      else if (ev.key === 'Enter') {
        ev.preventDefault();
        var target = list[selected >= 0 ? selected : 0];
        if (target && !panel.hidden) target.click();
        else if (input.value.trim().length > 1) { clearTimeout(timer); runSearch(input.value.trim(), panel, close, true); }
      }
    });
    input.addEventListener('focus', function () { if (panel.innerHTML && input.value.trim().length > 1) panel.hidden = false; });
    document.addEventListener('click', function (ev) {
      if (!panel.contains(ev.target) && ev.target !== input) close();
    });
    panel.addEventListener('click', function (ev) {
      var r = ev.target.closest('.result');
      if (!r) return;
      if (r.dataset.action === 'connect') { openLibrary(); close(); return; }
      close();
      input.blur();
      var open = panel.id === 'libraryResults' ? openFromLibrary : go;
      if (r.dataset.doc) open({ doc: r.dataset.doc });
      else open({ book: r.dataset.book, page: r.dataset.page });
    });
  }

  async function runSearch(q, panel, close, openFirst) {
    var seq = ++searchSeq;
    if (!state.connected) {
      panel.innerHTML = '<div class="result-note">Open your library first, then you can search it.' +
        '<button type="button" class="result result-action" data-action="connect">Open my library</button></div>';
      panel.hidden = false;
      return;
    }
    var books = state.books.filter(function (b) { return !b.info.error; });
    panel.innerHTML = '<div class="result-note"><span class="spinner small"></span> Searching…</div>';
    panel.hidden = false;
    var currentId = state.current && state.current.book && state.current.book.id;
    var lists = await Promise.all(books.map(function (b) {
      return getArchive(b).then(function (a) { return a.searchTitles(q, 12); }).then(function (rs) {
        return rs.map(function (r) { return { book: b, entry: r.entry, title: r.title, score: r.score + (b.id === currentId ? 30 : 0) }; });
      }).catch(function (err) { console.warn('Search failed in', b.id, err); return []; });
    }));
    if (seq !== searchSeq) return;
    lists.push(searchDocs(q));
    var all = [].concat.apply([], lists).sort(function (a, b) { return b.score - a.score; }).slice(0, 25);
    if (!all.length) {
      panel.innerHTML = '<div class="result-note"><strong>No matching titles.</strong>' +
        '<span>Try one key word, like “snake” instead of “bitten by a snake”, or check the spelling.</span></div>';
      return;
    }
    var multiBook = books.length > 1 || (books.length && state.docs.length);
    panel.innerHTML = all.map(function (r, i) {
      if (r.doc) {
        return '<button type="button" class="result" role="option" data-doc="' + escapeHtml(r.doc.id) + '">' +
          docIcon(r.doc.info, 'small') +
          '<span class="result-text"><span class="result-title">' + highlightMatch(r.title, q) + '</span>' +
          '<span class="result-book">My documents' + (r.doc.info.group ? ' › ' + escapeHtml(groupLabel(r.doc.info.group)) : '') + '</span>' +
          '</span></button>';
      }
      return '<button type="button" class="result" role="option" data-book="' + escapeHtml(r.book.id) +
        '" data-page="' + escapeHtml(r.entry.fullPath) + '">' +
        (multiBook ? bookIcon(r.book.info, 'small') : '') +
        '<span class="result-text"><span class="result-title">' + highlightMatch(r.title, q) + '</span>' +
        (multiBook ? '<span class="result-book">' + escapeHtml(r.book.info.title) + '</span>' : '') +
        '</span></button>';
    }).join('');
    if (openFirst) {
      close();
      var open = panel.id === 'libraryResults' ? openFromLibrary : go;
      if (all[0].doc) open({ doc: all[0].doc.id });
      else open({ book: all[0].book.id, page: all[0].entry.fullPath });
    }
  }

  /** Document names are matched in memory, scored like book titles so the lists merge sensibly. */
  function searchDocs(q) {
    var ql = q.toLowerCase();
    var words = ql.split(/\s+/).filter(function (w) { return w.length > 1; });
    var out = [];
    state.docs.forEach(function (d) {
      var t = d.info.title.toLowerCase();
      var hay = t + ' ' + d.info.group.toLowerCase();
      var tokens = hay.split(/[\s_()\-,.:;'"\/]+/);
      var s = 0, hits = 0;
      if (t === ql) s += 1000;
      else if (t.indexOf(ql) === 0) s += 400;
      else if (t.indexOf(ql) >= 0) s += 200;
      words.forEach(function (w) {
        if (tokens.indexOf(w) >= 0) { s += 80; hits++; }
        else if (hay.indexOf(w) >= 0) { s += 40; hits++; }
      });
      if (!s) return;
      // The reader's own papers are usually what they're after, so they get a small lift.
      out.push({ doc: d, title: d.info.title, score: s + 50 - t.length * 0.5 + (hits === words.length ? 40 : 0) });
    });
    return out;
  }

  function highlightMatch(title, q) {
    var words = q.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 1; });
    var html = escapeHtml(title);
    if (!words.length) return html;
    var re = new RegExp('(' + words.map(function (w) { return escapeHtml(w).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'gi');
    return html.replace(re, '<mark>$1</mark>');
  }

  // ---------------------------------------------------------------- routing

  function routeToHash(r) {
    if (r && r.doc) return '#' + new URLSearchParams({ doc: r.doc }).toString();
    if (!r || !r.book) return '#';
    var p = new URLSearchParams();
    p.set('book', r.book);
    if (r.page) p.set('page', r.page);
    if (r.at) p.set('at', r.at);
    return '#' + p.toString();
  }
  function hashToRoute() {
    var h = location.hash.replace(/^#/, '');
    if (!h) return null;
    var p = new URLSearchParams(h);
    if (p.get('doc')) return { doc: p.get('doc') };
    if (!p.get('book')) return null;
    return { book: p.get('book'), page: p.get('page') || '', at: p.get('at') || '' };
  }
  function go(r) {
    var h = routeToHash(r);
    if (location.hash === h || (h === '#' && !location.hash)) route();
    else location.hash = h;
  }

  /**
   * Opens a book or document picked from the library. With a remembered folder (Chrome/Edge) it gets a
   * new tab, which reconnects on its own, so the library stays open here. Firefox/Safari would have to
   * choose the folder again in every new tab, so they stay in this tab.
   */
  function openFromLibrary(r) {
    if (supportsFolderMemory && state.dirHandle) {
      var w = window.open(location.href.split('#')[0] + routeToHash(r), '_blank');
      if (w) return;
    }
    go(r);
  }

  /** "Back to library": a tab opened from the library closes, which returns to the library tab. */
  function backToLibrary() {
    if (window.opener && !window.opener.closed) {
      window.close();
      // Browsers can refuse to close a tab; fall back to showing the library here.
      setTimeout(function () { go(null); }, 150);
      return;
    }
    go(null);
  }

  function route(r) {
    r = r || hashToRoute();
    state.route = r;
    if (!r) { showView('library'); return; }
    var book = state.byId[r.book];
    if (!state.connected) {
      state.pendingRoute = r;
      showView('library');
      return;
    }
    if (r.doc) {
      var doc = state.docById[r.doc];
      if (!doc) { showView('library'); toast('That document isn\'t on this drive anymore.'); return; }
      showView('reader');
      showDocument(doc);
      return;
    }
    if (!book) { showView('library'); toast('That book isn\'t in this library.'); return; }
    showView('reader');
    showArticle(book, r.page || book.info.mainPath, r.at);
  }

  function showView(which) {
    var lib = which === 'library';
    $('libraryView').hidden = !lib;
    $('readerView').hidden = lib;
    document.body.classList.toggle('reading', !lib);
    if (lib) {
      state.current = null;
      document.title = CONFIG.title || 'ReadyUSB';
      renderShelf();
      var frame = $('page');
      if (frame.srcdoc) frame.removeAttribute('srcdoc');
      setReaderMode('book');
      setStatus(null);
      revokeBlobs();
    }
  }

  /**
   * mode: 'book' (ZIM pages), 'doc' (a document in the page frame), 'pdf' (browser PDF viewer)
   * or 'file' (a document we can only offer as a download).
   */
  function setReaderMode(mode) {
    var rv = $('readerView'), df = $('docFrame');
    rv.classList.toggle('is-doc', mode !== 'book');
    rv.classList.toggle('no-page-tools', mode === 'pdf' || mode === 'file');
    $('page').hidden = mode === 'pdf';
    df.hidden = mode !== 'pdf';
    if (mode !== 'pdf' && df.getAttribute('src')) df.src = 'about:blank';
    $('removeDocBtn').hidden = mode === 'book' || !canChangeDocs();
    $('bookHomeBtn').title = mode === 'book' ? 'Go to this book\'s front page' : 'Back to all books and documents';
  }

  // ---------------------------------------------------------------- reader

  function revokeBlobs() {
    state.blobUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    state.blobUrls = [];
  }
  function blobUrl(bytes, mime) {
    var u = URL.createObjectURL(new Blob([bytes], { type: baseMime(mime) }));
    state.blobUrls.push(u);
    return u;
  }

  function toUrlPath(fullPath) { return fullPath.split('/').map(encodeURIComponent).join('/'); }

  /** Turns a link inside a page into either a path inside the book or an outside web address. */
  function resolveLink(href, fromPath, archive) {
    var u;
    try { u = new URL(href, LINK_BASE + toUrlPath(fromPath)); } catch (e) { return null; }
    if (u.href.indexOf(LINK_BASE) === 0) {
      var p = u.pathname.slice(1).split('/').map(safeDecode).join('/');
      if (u.search) p += safeDecode(u.search);
      return { internal: true, path: p, anchor: u.hash ? safeDecode(u.hash.slice(1)) : '' };
    }
    if (/^https?:$/.test(u.protocol)) {
      var r = { external: true, url: u.href };
      if (archive && archive.isWebsiteCopy && archive.siteBase) {
        r.sitePath = archive.siteBase + u.host + safeDecode(u.pathname) + (u.search ? safeDecode(u.search) : '');
        r.anchor = u.hash ? safeDecode(u.hash.slice(1)) : '';
      }
      return r;
    }
    if (u.protocol === 'mailto:' || u.protocol === 'tel:') return { external: true, url: u.href };
    return null;
  }

  async function contentUrlFor(archive, path) {
    var e = await archive.findPath(path);
    if (!e) return null;
    e = await archive.resolve(e);
    return blobUrl(await archive.getContent(e), e.mimeType);
  }

  async function rewriteCss(css, cssPath, archive) {
    var re = /url\(\s*(['"]?)([^'")]+)\1\s*\)/g, m, urls = new Set();
    while ((m = re.exec(css))) {
      if (!/^(data:|#|blob:)/i.test(m[2])) urls.add(m[2]);
    }
    var map = {};
    await Promise.all(Array.from(urls).map(async function (ref) {
      var r = resolveLink(ref, cssPath);
      if (!r || !r.internal) return;
      try { map[ref] = await contentUrlFor(archive, r.path); } catch (e) { /* missing resource */ }
    }));
    return css.replace(re, function (all, q, ref) { return map[ref] ? 'url("' + map[ref] + '")' : all; });
  }

  var READER_CSS =
    'html{scroll-behavior:smooth}' +
    'body{overflow-wrap:break-word}' +
    'img,video{max-width:100%;height:auto}' +
    'a[href]{cursor:pointer}' +
    /* mwoffliner landing pages rely on a script for their grid; give them a plain one */
    '#content .item,.item{break-inside:avoid}' +
    '.mw-body .mw-content-container, .mw-page-container{max-width:62em;margin:0 auto}';

  async function buildPage(archive, entry, html) {
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var path = entry.fullPath;
    // Pages from the book never run their own scripts.
    doc.querySelectorAll('script, base, meta[http-equiv], iframe, object, embed, link[rel="preload"], link[rel="modulepreload"]').forEach(function (el) { el.remove(); });
    doc.querySelectorAll('*').forEach(function (el) {
      for (var i = el.attributes.length - 1; i >= 0; i--) {
        if (/^on/i.test(el.attributes[i].name)) el.removeAttribute(el.attributes[i].name);
      }
    });
    doc.querySelectorAll('a[href^="javascript:"]').forEach(function (a) { a.removeAttribute('href'); });

    // Stylesheets → inline <style> with their images and fonts loaded from the book
    var links = Array.prototype.slice.call(doc.querySelectorAll('link'));
    await Promise.all(links.map(async function (link) {
      var rel = (link.getAttribute('rel') || '').toLowerCase();
      if (rel.split(/\s+/).indexOf('stylesheet') < 0) { link.remove(); return; }
      var r = resolveLink(link.getAttribute('href') || '', path);
      if (!r || !r.internal) { link.remove(); return; }
      try {
        var ce = await archive.findPath(r.path);
        if (!ce) { link.remove(); return; }
        ce = await archive.resolve(ce);
        var css = await rewriteCss(await archive.getText(ce), ce.fullPath, archive);
        var style = doc.createElement('style');
        if (link.media) style.media = link.media;
        style.textContent = css;
        link.replaceWith(style);
      } catch (e) { link.remove(); }
    }));
    var styles = Array.prototype.slice.call(doc.querySelectorAll('style'));
    await Promise.all(styles.map(async function (st) {
      if (/url\(/i.test(st.textContent)) st.textContent = await rewriteCss(st.textContent, path, archive);
    }));

    // Images and media: remember where they live in the book; they're filled in after the page shows.
    doc.querySelectorAll('img, video, audio, source, track, input[type="image"]').forEach(function (el) {
      var src = el.getAttribute('src');
      el.removeAttribute('srcset');
      el.removeAttribute('sizes');
      if (src && !/^(data:|blob:)/i.test(src)) {
        var r = resolveLink(src, path);
        if (r && r.internal) el.setAttribute('data-zim-src', r.path);
        el.removeAttribute('src');
      }
      var poster = el.getAttribute('poster');
      if (poster) {
        var rp = resolveLink(poster, path);
        if (rp && rp.internal) el.setAttribute('data-zim-poster', rp.path);
        el.removeAttribute('poster');
      }
      if (el.tagName === 'IMG') el.removeAttribute('loading');
    });

    var extra = doc.createElement('style');
    extra.textContent = READER_CSS;
    (doc.head || doc.documentElement).appendChild(extra);
    var meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    if (doc.head) doc.head.insertBefore(meta, doc.head.firstChild);
    return '<!DOCTYPE html>' + doc.documentElement.outerHTML;
  }

  async function fillMedia(idoc, archive, token) {
    var els = Array.prototype.slice.call(idoc.querySelectorAll('[data-zim-src], [data-zim-poster]'));
    var i = 0;
    async function worker() {
      while (i < els.length) {
        if (token !== state.navToken) return;
        var el = els[i++];
        var attrs = [['data-zim-src', 'src'], ['data-zim-poster', 'poster']];
        for (var k = 0; k < attrs.length; k++) {
          var p = el.getAttribute(attrs[k][0]);
          if (!p) continue;
          try {
            var u = await contentUrlFor(archive, p);
            if (token !== state.navToken) return;
            if (u) el.setAttribute(attrs[k][1], u);
            else el.classList.add('zim-missing');
          } catch (e) { el.classList.add('zim-missing'); }
        }
        if ((el.tagName === 'SOURCE' || el.tagName === 'TRACK') && el.parentNode && el.parentNode.load) {
          try { el.parentNode.load(); } catch (e) { /* ignore */ }
        }
      }
    }
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  function setStatus(html, kind) {
    var s = $('readerStatus');
    if (!html) { s.hidden = true; return; }
    s.className = 'reader-status' + (kind ? ' ' + kind : '');
    s.innerHTML = html;
    s.hidden = false;
  }

  function updateBookChip(book) {
    $('bookChipIcon').innerHTML = bookIcon(book.info, 'small');
    $('bookChipTitle').textContent = book.info.title;
  }

  async function showArticle(book, path, anchor) {
    var token = ++state.navToken;
    var oldBlobs = state.blobUrls;
    state.blobUrls = [];
    updateBookChip(book);
    setReaderMode('book');
    if (state.current && state.current.book === book && state.current.path === path && !anchor) return;
    var slow = setTimeout(function () {
      if (token === state.navToken) setStatus('<span class="spinner"></span><span>Opening page…</span>', 'loading');
    }, 250);
    try {
      var archive = await getArchive(book);
      if (!path) throw Object.assign(new Error('no main page'), { code: 'NO_MAIN' });
      var entry = await archive.findPath(path);
      if (!entry) throw Object.assign(new Error('missing'), { code: 'NOT_FOUND' });
      entry = await archive.resolve(entry);
      var mime = baseMime(entry.mimeType);
      var frame = $('page');
      var html;
      if (/html/.test(mime)) {
        html = await buildPage(archive, entry, await archive.getText(entry));
      } else if (/^image\//.test(mime)) {
        html = '<!DOCTYPE html><meta charset="utf-8"><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#f4f4f2}img{max-width:100%}</style><img data-zim-src="' + escapeHtml(entry.fullPath) + '" alt="">';
      } else {
        var url = blobUrl(await archive.getContent(entry), mime);
        html = '<!DOCTYPE html><meta charset="utf-8"><style>body{font:16px system-ui,sans-serif;padding:3em;color:#222}</style>' +
          '<p>This item is a file (' + escapeHtml(mime) + ').</p><p><a download="' + escapeHtml(entry.path.split('/').pop()) + '" href="' + url + '" data-download="1">Save a copy of this file</a></p>';
      }
      if (token !== state.navToken) return;
      await new Promise(function (resolve) {
        frame.onload = function () { frame.onload = null; resolve(); };
        frame.srcdoc = html;
      });
      oldBlobs.forEach(function (u) { URL.revokeObjectURL(u); });
      if (token !== state.navToken) return;
      clearTimeout(slow);
      setStatus(null);
      state.current = { book: book, entry: entry, path: path, archive: archive };
      var title = entry.title && entry.title !== entry.path ? entry.title : (frame.contentDocument.title || entry.title);
      document.title = title + ' · ' + book.info.title;
      wireFrame(frame, archive, entry);
      applyTextScale();
      if (anchor) scrollToAnchor(frame.contentDocument, anchor);
      else frame.contentWindow.scrollTo(0, 0);
      fillMedia(frame.contentDocument, archive, token);
    } catch (err) {
      clearTimeout(slow);
      if (token !== state.navToken) return;
      console.warn('Could not show page', path, err);
      var msg;
      if (err.code === 'NOT_FOUND') msg = '<strong>This page isn\'t included in this book.</strong><span>Some books are shortened copies and leave out less common pages.</span>';
      else if (err.code === 'NO_MAIN') msg = '<strong>This book has no front page.</strong>' +
        (SHOW_SEARCH ? '<span>Use the search box above to find something in it.</span>' : '<span>It can\'t be opened from the library yet.</span>');
      else msg = '<strong>' + escapeHtml(friendlyError(err)) + '</strong>';
      $('page').removeAttribute('srcdoc');
      state.current = { book: book, entry: null, path: path };
      setStatus(msg + '<span class="status-actions"><button type="button" class="primary-button small" id="statusBackBtn">Go back</button>' +
        '<button type="button" class="link-button" id="statusHomeBtn">Front page of this book</button></span>', 'error');
      $('statusBackBtn').onclick = function () { history.back(); };
      $('statusHomeBtn').onclick = function () { go({ book: book.id }); };
    }
  }

  var MAX_TEXT_BYTES = 4 * 1024 * 1024;

  async function documentHtml(info, file, url) {
    var page = 'body{margin:0;background:#f4f4f2;display:grid;place-items:center;min-height:100vh}';
    if (info.kind === 'image') {
      return '<!DOCTYPE html><meta charset="utf-8"><style>' + page + 'img{max-width:100%;height:auto}</style><img src="' + url + '" alt="">';
    }
    if (info.kind === 'video' || info.kind === 'audio') {
      return '<!DOCTYPE html><meta charset="utf-8"><style>' + page + 'video,audio{max-width:100%}</style>' +
        '<' + info.kind + ' controls src="' + url + '"></' + info.kind + '>';
    }
    var tooBig = file.size > MAX_TEXT_BYTES;
    var text = await (tooBig ? file.slice(0, MAX_TEXT_BYTES) : file).text();
    // Scripts never run: the page frame is sandboxed. Saved web pages may miss their pictures.
    if (info.kind === 'html') return text;
    return '<!DOCTYPE html><meta charset="utf-8"><style>' +
      'body{margin:0;padding:2.5em 1.5em;background:#fff;color:#1d2725;font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}' +
      'pre{max-width:46em;margin:0 auto;white-space:pre-wrap;overflow-wrap:break-word;font:inherit}' +
      (info.ext === 'csv' ? 'pre{max-width:none;font:14px/1.5 ui-monospace,Consolas,monospace;white-space:pre}' : '') +
      'p{max-width:46em;margin:2em auto 0;color:#6f7a77}</style>' +
      '<pre>' + escapeHtml(text) + '</pre>' +
      (tooBig ? '<p>This file is very long, so only the beginning is shown.</p>' : '');
  }

  async function showDocument(doc) {
    var info = doc.info;
    if (state.current && state.current.doc === doc) return;
    var token = ++state.navToken;
    var oldBlobs = state.blobUrls;
    state.blobUrls = [];
    $('bookChipIcon').innerHTML = docIcon(info, 'small');
    $('bookChipTitle').textContent = info.title;
    setReaderMode(info.kind === 'pdf' || info.kind === 'file' ? info.kind : 'doc');
    setStatus(null);
    try {
      // Read the file again from the drive when we can, in case it changed since the shelf was built.
      var file = doc.handle ? await doc.handle.getFile() : doc.file;
      if (token !== state.navToken) return;
      var url = blobUrl(file, docType(info).mime || file.type || 'application/octet-stream');
      state.current = { doc: doc };
      document.title = info.title + ' · My documents';
      if (info.kind === 'pdf') {
        $('docFrame').src = url;
      } else if (info.kind === 'file') {
        $('page').removeAttribute('srcdoc');
        setStatus('<strong>“' + escapeHtml(info.title) + '” can\'t be shown here.</strong>' +
          '<span>It\'s a ' + escapeHtml(docType(info).label) + '. Save a copy to this computer, then open it with a program like Word, Excel or LibreOffice.</span>' +
          '<span class="status-actions"><a class="primary-button small" id="statusSaveBtn" download="' + escapeHtml(info.name) + '" href="' + url + '">Save a copy</a>' +
          '<button type="button" class="link-button" id="statusHomeBtn">Back to all books and documents</button></span>', 'file');
        $('statusHomeBtn').onclick = backToLibrary;
      } else {
        var html = await documentHtml(info, file, url);
        if (token !== state.navToken) return;
        var frame = $('page');
        await new Promise(function (resolve) {
          frame.onload = function () { frame.onload = null; resolve(); };
          frame.srcdoc = html;
        });
        if (token !== state.navToken) return;
        applyTextScale();
      }
      oldBlobs.forEach(function (u) { URL.revokeObjectURL(u); });
    } catch (err) {
      if (token !== state.navToken) return;
      console.warn('Could not show document', info.id, err);
      state.current = { doc: doc };
      $('page').removeAttribute('srcdoc');
      setStatus('<strong>This document couldn\'t be opened.</strong><span>Is the drive still plugged in?</span>' +
        '<span class="status-actions"><button type="button" class="primary-button small" id="statusBackBtn">Go back</button></span>', 'error');
      $('statusBackBtn').onclick = function () { history.back(); };
    }
  }

  function scrollToAnchor(idoc, anchor) {
    var t = idoc.getElementById(anchor) || idoc.getElementsByName(anchor)[0];
    if (t) t.scrollIntoView();
  }

  function wireFrame(frame, archive, entry) {
    var idoc = frame.contentDocument;
    if (!idoc) return;
    idoc.addEventListener('click', function (ev) {
      if (ev.button !== 0) return;
      var a = ev.target.closest && ev.target.closest('a[href], area[href]');
      if (!a || a.getAttribute('data-download')) return;
      var href = a.getAttribute('href');
      ev.preventDefault();
      if (href.charAt(0) === '#') {
        var id = safeDecode(href.slice(1));
        if (id) scrollToAnchor(idoc, id); else frame.contentWindow.scrollTo(0, 0);
        return;
      }
      var r = resolveLink(href, entry.fullPath, archive);
      if (!r) return;
      if (r.internal) {
        if (r.path === entry.fullPath) { if (r.anchor) scrollToAnchor(idoc, r.anchor); return; }
        go({ book: state.current.book.id, page: r.path, at: r.anchor });
        return;
      }
      if (r.sitePath) {
        archive.findPath(r.sitePath).then(function (found) {
          if (found) go({ book: state.current.book.id, page: r.sitePath, at: r.anchor });
          else openExternal(r.url);
        });
        return;
      }
      openExternal(r.url);
    });
    idoc.addEventListener('keydown', function (ev) {
      if (SHOW_SEARCH && ev.key === '/' && !/input|textarea/i.test(ev.target.tagName)) { ev.preventDefault(); $('readerSearch').focus(); }
    });
    // Close any open result list when the page is clicked.
    idoc.addEventListener('mousedown', function () { $('readerResults').hidden = true; });
  }

  function openExternal(url) {
    if (!navigator.onLine) {
      toast('That link goes to a website on the internet, and this computer is offline.');
      return;
    }
    toast('Opening a website in a new tab. It needs internet.');
    window.open(url, '_blank', 'noopener');
  }

  function applyTextScale() {
    var frame = $('page');
    var idoc = frame.contentDocument;
    if (idoc && idoc.body) idoc.body.style.zoom = state.textScale === 1 ? '' : String(state.textScale);
  }
  function changeTextScale(delta) {
    var s = Math.round((state.textScale + delta) * 100) / 100;
    state.textScale = Math.min(1.8, Math.max(0.8, s));
    lsSet(TEXT_KEY, state.textScale);
    applyTextScale();
  }

  // ---------------------------------------------------------------- startup

  function bindEvents() {
    $('connectBtn').addEventListener('click', openLibrary);
    $('welcomeOpenBtn').addEventListener('click', openLibrary);
    $('welcomeHelpBtn').addEventListener('click', showOpenHelp);
    $('changeFolderBtn').addEventListener('click', function () { state.dirHandle = null; openLibrary(); });
    $('pickFilesBtn').addEventListener('click', function () { $('filesInput').value = ''; $('filesInput').click(); });
    $('folderInput').addEventListener('change', function () {
      if (!this.files.length) return;
      var entries = filesFromInput(this);
      loadFiles(entries, { libraryRoot: isLibraryPick(entries) });
    });
    $('filesInput').addEventListener('change', function () { if (this.files.length) loadFiles(filesFromInput(this), { keepDocs: true }); });
    $('addDocsBtn').addEventListener('click', addDocuments);
    $('removeDocBtn').addEventListener('click', confirmRemove);

    $('docsSection').addEventListener('click', function (ev) {
      if (ev.target.closest('#docsChooseDriveBtn')) { state.dirHandle = null; openLibrary(); return; }
      var card = ev.target.closest('.doc-card');
      if (!card) return;
      var id = card.getAttribute('data-doc');
      if (!state.connected) { state.pendingRoute = { doc: id }; openLibrary(); return; }
      openFromLibrary({ doc: id });
    });

    $('shelf').addEventListener('click', function (ev) {
      var card = ev.target.closest('.book-card');
      if (!card) return;
      var id = card.getAttribute('data-book');
      if (!state.connected) { state.pendingRoute = { book: id }; openLibrary(); return; }
      var book = state.byId[id];
      if (book && book.info.error) { toast(book.info.error); return; }
      openFromLibrary({ book: id });
    });

    $('libraryBtn').addEventListener('click', backToLibrary);
    $('bookHomeBtn').addEventListener('click', function () {
      if (state.current && state.current.book) go({ book: state.current.book.id });
      else backToLibrary();
    });
    $('backBtn').addEventListener('click', function () { history.back(); });
    $('forwardBtn').addEventListener('click', function () { history.forward(); });
    $('textSmallerBtn').addEventListener('click', function () { changeTextScale(-0.1); });
    $('textLargerBtn').addEventListener('click', function () { changeTextScale(0.1); });
    $('printBtn').addEventListener('click', function () {
      var w = $('page').contentWindow;
      if (w && state.current && (state.current.entry || state.current.doc)) w.print(); else window.print();
    });

    attachSearch($('librarySearch'), $('libraryResults'));
    attachSearch($('readerSearch'), $('readerResults'));
    window.addEventListener('hashchange', function () { route(); });
    // A document added or removed in another tab (books open in their own tabs): refresh this shelf.
    window.addEventListener('storage', function (ev) {
      if (ev.key === CACHE_KEY && state.connected && state.libraryDir) refreshDocs(true);
    });

    // Drop .zim files anywhere on the library page to read them; drop other files to add them as documents.
    document.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    document.addEventListener('drop', function (ev) {
      ev.preventDefault();
      var files = Array.prototype.slice.call((ev.dataTransfer && ev.dataTransfer.files) || []);
      if (!files.length) return;
      var zims = files.filter(function (f) { return /\.zim$/i.test(f.name); });
      if (zims.length) loadFiles(zims.map(function (f) { return { file: f, path: f.name }; }), { keepDocs: true });
      else if (canChangeDocs()) askWhereToSave(files.filter(function (f) { return isDocName(f.name); }));
      else if (state.connected) showAddHelp();
      else toast('Open your library first, then you can add documents to it.');
    });
  }

  async function start() {
    document.body.classList.toggle('no-search', !SHOW_SEARCH);
    applyConfig();
    bindEvents();
    var ts = lsGet(TEXT_KEY);
    if (typeof ts === 'number') state.textScale = ts;
    state.pendingRoute = hashToRoute();
    renderShelf();
    // avoid a flash before we know whether the folder is remembered
    $('connectCard').hidden = true;
    $('welcomeBar').hidden = true;

    if (supportsFolderMemory) {
      var handle = await idbGet('libraryFolder');
      if (handle) {
        state.dirHandle = handle;
        var perm = 'prompt';
        try { perm = await handle.queryPermission({ mode: 'read' }); } catch (e) { /* ignore */ }
        if (perm === 'granted') { await connectHandle(handle); return; }
      }
    }
    renderShelf();
    route();
    if (SHOW_SEARCH) $('librarySearch').focus();
  }

  start();
})();
