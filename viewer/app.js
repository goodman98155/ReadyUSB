/*
 * ReadyUSB — app.js
 * Library shelf, folder access, search and the article reader.
 * Plain browser JavaScript: no build step, no server, no internet.
 * Part of ReadyUSB. MIT License — see viewer/LICENSE.txt
 */
(function () {
  'use strict';

  var CONFIG = window.LIBRARY_CONFIG || {};
  var CACHE_KEY = 'readyusb.shelf.v1';
  var TEXT_KEY = 'readyusb.textScale';
  var DB_NAME = 'readyusb';
  var LINK_BASE = 'http://zim.invalid/';
  var MAX_SCAN_DEPTH = 3;
  var supportsFolderMemory = typeof window.showDirectoryPicker === 'function';

  var state = {
    books: [],            // {id, file?, info, archive?, error?}
    byId: {},
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

  // ---------------------------------------------------------------- config text

  function applyConfig() {
    document.querySelectorAll('[data-config]').forEach(function (el) {
      var v = CONFIG[el.getAttribute('data-config')];
      if (v) el.textContent = v;
    });
    var folder = CONFIG.zimFolderName || 'zims';
    document.querySelectorAll('.zim-folder-name').forEach(function (el) { el.textContent = folder; });
    if (CONFIG.title) document.title = CONFIG.title;
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

  async function loadFiles(entries) {
    // entries: [{file, path}]
    var zims = entries.filter(function (e) { return /\.zim$/i.test(e.file.name); });
    if (!zims.length) {
      showLibraryMessage('No books found there',
        'We couldn\'t find any .zim book files in that folder. Try again and choose the folder named <strong>' +
        escapeHtml(CONFIG.zimFolderName || 'zims') + '</strong>, or the drive itself.', true);
      return false;
    }
    showLibraryMessage(null);
    setLoading(true, 'Opening ' + zims.length + (zims.length === 1 ? ' book…' : ' books…'));
    var cache = lsGet(CACHE_KEY) || { books: [] };
    var cachedById = {};
    (cache.books || []).forEach(function (b) { cachedById[b.id] = b; });
    var books = await Promise.all(zims.map(function (z) { return describeFile(z.file, z.path, cachedById[z.path]); }));
    books.sort(function (a, b) { return a.info.title.localeCompare(b.info.title); });
    state.books = books;
    state.byId = {};
    books.forEach(function (b) { state.byId[b.id] = b; });
    state.connected = true;
    lsSet(CACHE_KEY, { books: books.map(function (b) { return b.info; }), savedAt: Date.now() });
    setLoading(false);
    renderShelf();
    if (state.pendingRoute) { var r = state.pendingRoute; state.pendingRoute = null; route(r); }
    else route();
    return true;
  }

  async function scanDirectory(dir, prefix, depth, out) {
    for await (var pair of dir.entries()) {
      var name = pair[0], handle = pair[1];
      if (handle.kind === 'file') {
        if (/\.zim$/i.test(name)) out.push({ file: await handle.getFile(), path: prefix + name });
      } else if (depth < MAX_SCAN_DEPTH && !/^(\$RECYCLE\.BIN|System Volume Information|\.)/i.test(name)) {
        try { await scanDirectory(handle, prefix + name + '/', depth + 1, out); } catch (e) { /* skip unreadable folder */ }
      }
    }
    return out;
  }

  async function connectHandle(handle) {
    state.dirHandle = handle;
    setLoading(true, 'Looking for books…');
    try {
      var found = await scanDirectory(handle, '', 0, []);
      // Use paths relative to the "zims" folder when the drive root was chosen, so ids stay stable.
      found.forEach(function (f) { f.path = stripZimFolder(f.path); });
      return await loadFiles(found);
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
      return { file: f, path: stripZimFolder(f.webkitRelativePath || f.name) };
    });
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
    var cache = lsGet(CACHE_KEY);
    var infos = state.connected ? state.books.map(function (b) { return b.info; }) : ((cache && cache.books) || []);
    var shelf = $('shelf');
    $('shelfSection').hidden = !infos.length;
    $('shelfCount').textContent = infos.length ? infos.length + (infos.length === 1 ? ' book' : ' books') : '';
    $('changeFolderBtn').hidden = !state.connected;

    var cc = $('connectCard');
    cc.hidden = state.connected;
    if (!state.connected) {
      var returning = infos.length > 0;
      $('connectTitle').textContent = returning ? 'Welcome back' : 'Open your library';
      $('connectText').textContent = returning
        ? 'Click a book below, or the button, to open your library again.'
        : 'Your browser needs permission once to see the books on this drive.';
      $('connectSteps').hidden = returning && !!state.dirHandle;
    }

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
      go({ book: r.dataset.book, page: r.dataset.page });
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
    var currentId = state.current && state.current.book.id;
    var lists = await Promise.all(books.map(function (b) {
      return getArchive(b).then(function (a) { return a.searchTitles(q, 12); }).then(function (rs) {
        return rs.map(function (r) { return { book: b, entry: r.entry, title: r.title, score: r.score + (b.id === currentId ? 30 : 0) }; });
      }).catch(function (err) { console.warn('Search failed in', b.id, err); return []; });
    }));
    if (seq !== searchSeq) return;
    var all = [].concat.apply([], lists).sort(function (a, b) { return b.score - a.score; }).slice(0, 25);
    if (!all.length) {
      panel.innerHTML = '<div class="result-note"><strong>No matching titles.</strong>' +
        '<span>Try one key word, like “snake” instead of “bitten by a snake”, or check the spelling.</span></div>';
      return;
    }
    var multiBook = books.length > 1;
    panel.innerHTML = all.map(function (r, i) {
      return '<button type="button" class="result" role="option" data-book="' + escapeHtml(r.book.id) +
        '" data-page="' + escapeHtml(r.entry.fullPath) + '">' +
        (multiBook ? bookIcon(r.book.info, 'small') : '') +
        '<span class="result-text"><span class="result-title">' + highlightMatch(r.title, q) + '</span>' +
        (multiBook ? '<span class="result-book">' + escapeHtml(r.book.info.title) + '</span>' : '') +
        '</span></button>';
    }).join('');
    if (openFirst) { close(); go({ book: all[0].book.id, page: all[0].entry.fullPath }); }
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
    if (!p.get('book')) return null;
    return { book: p.get('book'), page: p.get('page') || '', at: p.get('at') || '' };
  }
  function go(r) {
    var h = routeToHash(r);
    if (location.hash === h || (h === '#' && !location.hash)) route();
    else location.hash = h;
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
      if (frame.srcdoc) { frame.removeAttribute('srcdoc'); revokeBlobs(); }
    }
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
      else if (err.code === 'NO_MAIN') msg = '<strong>This book has no front page.</strong><span>Use the search box above to find something in it.</span>';
      else msg = '<strong>' + escapeHtml(friendlyError(err)) + '</strong>';
      $('page').removeAttribute('srcdoc');
      state.current = { book: book, entry: null, path: path };
      setStatus(msg + '<span class="status-actions"><button type="button" class="primary-button small" id="statusBackBtn">Go back</button>' +
        '<button type="button" class="link-button" id="statusHomeBtn">Front page of this book</button></span>', 'error');
      $('statusBackBtn').onclick = function () { history.back(); };
      $('statusHomeBtn').onclick = function () { go({ book: book.id }); };
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
      if (ev.key === '/' && !/input|textarea/i.test(ev.target.tagName)) { ev.preventDefault(); $('readerSearch').focus(); }
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
    $('changeFolderBtn').addEventListener('click', function () { state.dirHandle = null; openLibrary(); });
    $('pickFilesBtn').addEventListener('click', function () { $('filesInput').value = ''; $('filesInput').click(); });
    $('folderInput').addEventListener('change', function () { if (this.files.length) loadFiles(filesFromInput(this)); });
    $('filesInput').addEventListener('change', function () { if (this.files.length) loadFiles(filesFromInput(this)); });

    $('shelf').addEventListener('click', function (ev) {
      var card = ev.target.closest('.book-card');
      if (!card) return;
      var id = card.getAttribute('data-book');
      if (!state.connected) { state.pendingRoute = { book: id }; openLibrary(); return; }
      var book = state.byId[id];
      if (book && book.info.error) { toast(book.info.error); return; }
      go({ book: id });
    });

    $('libraryBtn').addEventListener('click', function () { go(null); });
    $('bookHomeBtn').addEventListener('click', function () { if (state.current) go({ book: state.current.book.id }); });
    $('backBtn').addEventListener('click', function () { history.back(); });
    $('forwardBtn').addEventListener('click', function () { history.forward(); });
    $('textSmallerBtn').addEventListener('click', function () { changeTextScale(-0.1); });
    $('textLargerBtn').addEventListener('click', function () { changeTextScale(0.1); });
    $('printBtn').addEventListener('click', function () {
      var w = $('page').contentWindow;
      if (w && state.current && state.current.entry) w.print(); else window.print();
    });

    attachSearch($('librarySearch'), $('libraryResults'));
    attachSearch($('readerSearch'), $('readerResults'));
    window.addEventListener('hashchange', function () { route(); });

    // Drop .zim files anywhere on the library page
    document.addEventListener('dragover', function (ev) { ev.preventDefault(); });
    document.addEventListener('drop', function (ev) {
      ev.preventDefault();
      var files = Array.prototype.slice.call((ev.dataTransfer && ev.dataTransfer.files) || []);
      if (files.length) loadFiles(files.map(function (f) { return { file: f, path: f.name }; }));
    });
  }

  async function start() {
    applyConfig();
    bindEvents();
    var ts = lsGet(TEXT_KEY);
    if (typeof ts === 'number') state.textScale = ts;
    state.pendingRoute = hashToRoute();
    renderShelf();
    $('connectCard').hidden = true; // avoid a flash before we know whether the folder is remembered

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
    $('librarySearch').focus();
  }

  start();
})();
