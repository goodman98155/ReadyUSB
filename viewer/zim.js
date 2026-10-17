/*
 * zim.js — a small, dependency-light reader for ZIM archives (openZIM format).
 * Reads directly from a File/Blob using ranged reads, so multi-gigabyte files
 * are never loaded into memory. Needs vendor/fzstd.js for zstd-compressed clusters.
 *
 * Part of ReadyUSB. MIT License — see viewer/LICENSE.txt
 * Format reference: https://wiki.openzim.org/wiki/ZIM_file_format
 */
(function (root) {
  'use strict';

  var MAGIC = 72173914;          // 0x044D495A
  var NO_INDEX = 0xffffffff;
  var REDIRECT = 0xffff;
  var utf8 = new TextDecoder('utf-8');
  var enc = new TextEncoder();
  var MAX_CACHED_CLUSTERS = 8;
  var MAX_CACHED_ENTRIES = 20000;

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 0x1000000; }
  function u64(b, o) { return u32(b, o) + u32(b, o + 4) * 4294967296; }

  function cmpBytes(a, b) {
    var n = a.length < b.length ? a.length : b.length;
    for (var i = 0; i < n; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
    return a.length - b.length;
  }
  function startsWithBytes(a, p) {
    if (a.length < p.length) return false;
    for (var i = 0; i < p.length; i++) { if (a[i] !== p[i]) return false; }
    return true;
  }

  /**
   * First index in [0, count) where isLess(i) is false. Probes several points at once so
   * file reads overlap (much faster than one-at-a-time binary search on slow drives).
   */
  async function lowerBound(count, isLess) {
    var lo = 0, hi = count;
    while (hi - lo > 8) {
      var step = (hi - lo) / 4;
      var probes = [Math.floor(lo + step), Math.floor(lo + 2 * step), Math.floor(lo + 3 * step)];
      var less = await Promise.all(probes.map(isLess));
      var nlo = lo, nhi = hi;
      for (var j = 0; j < probes.length; j++) {
        if (less[j]) nlo = probes[j] + 1;
        else { nhi = probes[j]; break; }
      }
      lo = nlo; hi = nhi;
    }
    var idx = [];
    for (var i = lo; i < hi; i++) idx.push(i);
    var res = await Promise.all(idx.map(isLess));
    for (var k = 0; k < res.length; k++) if (!res[k]) return idx[k];
    return hi;
  }

  function ZimError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function Archive(file, name) {
    this.file = file;
    this.name = name || file.name;
    this._entries = new Map();
    this._clusters = new Map();
    this._titleIndex = null;
  }

  Archive.prototype._read = function (pos, len) {
    var end = Math.min(pos + len, this.file.size);
    if (pos >= end) return Promise.resolve(new Uint8Array(0));
    return this.file.slice(pos, end).arrayBuffer().then(function (b) { return new Uint8Array(b); });
  };

  /** Reads the header and MIME list. Must be called before anything else. */
  Archive.prototype.open = async function () {
    var h = await this._read(0, 80);
    if (h.length < 80 || u32(h, 0) !== MAGIC) throw ZimError('NOT_ZIM', 'This is not a ZIM file.');
    this.major = u16(h, 4);
    this.minor = u16(h, 6);
    this.entryCount = u32(h, 24);
    this.clusterCount = u32(h, 28);
    this.pathPtrPos = u64(h, 32);
    this.titlePtrPos = u64(h, 40);
    this.clusterPtrPos = u64(h, 48);
    this.mimeListPos = u64(h, 56);
    this.mainPage = u32(h, 64);
    this.checksumPos = u64(h, 72);
    // Newer ZIMs put all user content in namespace "C"; older ones use "A" (articles), "I" (images), etc.
    this.newScheme = this.major >= 6 && this.minor >= 1;

    var mlEnd = this.pathPtrPos > this.mimeListPos ? this.pathPtrPos : this.mimeListPos + 65536;
    var ml = await this._read(this.mimeListPos, Math.min(mlEnd - this.mimeListPos, 65536));
    this.mimeTypes = [];
    for (var i = 0, s = 0; i < ml.length; i++) {
      if (ml[i] === 0) {
        if (i === s) break;
        this.mimeTypes.push(utf8.decode(ml.subarray(s, i)));
        s = i + 1;
      }
    }
    return this;
  };

  // ---------- Directory entries ----------

  Archive.prototype._parseEntry = async function (offset, index) {
    var len = 512, b, start, pathEnd, titleEnd;
    for (;;) {
      b = await this._read(offset, len);
      start = u16(b, 0) === REDIRECT ? 12 : 16;
      pathEnd = b.indexOf(0, start);
      titleEnd = pathEnd < 0 ? -1 : b.indexOf(0, pathEnd + 1);
      if (titleEnd >= 0 || b.length < len) break;
      len *= 4;
      if (len > 262144) throw ZimError('DAMAGED', 'Damaged directory entry.');
    }
    if (titleEnd < 0) throw ZimError('DAMAGED', 'Damaged directory entry.');
    var mime = u16(b, 0);
    var e = {
      index: index,
      ns: String.fromCharCode(b[3]),
      isRedirect: mime === REDIRECT,
      path: utf8.decode(b.subarray(start, pathEnd)),
      title: utf8.decode(b.subarray(pathEnd + 1, titleEnd))
    };
    if (!e.title) e.title = e.path;
    if (e.isRedirect) {
      e.redirectIndex = u32(b, 8);
      e.mimeType = null;
    } else {
      e.cluster = u32(b, 8);
      e.blob = u32(b, 12);
      e.mimeType = mime >= 0xfffd ? null : (this.mimeTypes[mime] || 'application/octet-stream');
      e.isSpecial = mime >= 0xfffd; // link target / deleted entry (very old ZIMs)
    }
    e.fullPath = e.ns + '/' + e.path;
    return e;
  };

  /** Entry by its index in the path-ordered list. */
  Archive.prototype.entryAt = function (index) {
    var cached = this._entries.get(index);
    if (cached) return cached;
    var self = this;
    var p = this._read(this.pathPtrPos + 8 * index, 8).then(function (b) {
      return self._parseEntry(u64(b, 0), index);
    });
    if (this._entries.size > MAX_CACHED_ENTRIES) this._entries.clear();
    this._entries.set(index, p);
    p.catch(function () { self._entries.delete(index); });
    return p;
  };

  function pathKey(e) { return e._pk || (e._pk = enc.encode(e.ns + e.path)); }

  /** Finds an entry by full path such as "C/Albert_Einstein" or "A/Water.html". */
  Archive.prototype.findPath = async function (fullPath) {
    if (!fullPath || fullPath.charAt(1) !== '/') return null;
    var key = enc.encode(fullPath.charAt(0) + fullPath.slice(2));
    var self = this;
    var i = await lowerBound(this.entryCount, function (n) {
      return self.entryAt(n).then(function (e) { return cmpBytes(pathKey(e), key) < 0; });
    });
    if (i >= this.entryCount) return null;
    var e = await this.entryAt(i);
    return cmpBytes(pathKey(e), key) === 0 ? e : null;
  };

  /** Follows redirects to the real entry. */
  Archive.prototype.resolve = async function (e) {
    for (var i = 0; e && e.isRedirect && i < 50; i++) e = await this.entryAt(e.redirectIndex);
    if (e && e.isRedirect) throw ZimError('DAMAGED', 'Redirect loop.');
    return e;
  };

  Archive.prototype.mainEntry = async function () {
    if (this.mainPage === NO_INDEX || this.mainPage >= this.entryCount) return null;
    return this.resolve(await this.entryAt(this.mainPage));
  };

  // ---------- Content ----------

  Archive.prototype._clusterInfo = async function (c) {
    if (c >= this.clusterCount) throw ZimError('DAMAGED', 'Bad cluster number.');
    var b = await this._read(this.clusterPtrPos + 8 * c, 16);
    var start = u64(b, 0);
    var end = c + 1 < this.clusterCount ? u64(b, 8) : (this.checksumPos || this.file.size);
    var info = (await this._read(start, 1))[0];
    return { start: start, end: end, compression: info & 0x0f, offsetSize: (info & 0x10) ? 8 : 4 };
  };

  Archive.prototype._decompressedCluster = function (c, ci) {
    var cached = this._clusters.get(c);
    if (cached) {
      this._clusters.delete(c); this._clusters.set(c, cached); // mark as recently used
      return cached;
    }
    var self = this;
    var p = this._read(ci.start + 1, ci.end - ci.start - 1).then(function (raw) {
      if (ci.compression === 5) {
        if (!root.fzstd) throw ZimError('NO_DECODER', 'zstd decoder missing.');
        return root.fzstd.decompress(raw);
      }
      if (ci.compression === 4) throw ZimError('OLD_FORMAT', 'This book uses an older compression format (XZ) that this reader does not support yet.');
      throw ZimError('UNKNOWN_COMPRESSION', 'Unknown compression type ' + ci.compression + '.');
    });
    this._clusters.set(c, p);
    p.catch(function () { self._clusters.delete(c); });
    while (this._clusters.size > MAX_CACHED_CLUSTERS) this._clusters.delete(this._clusters.keys().next().value);
    return p;
  };

  /**
   * Locates an entry's bytes. Returns {offset, size} for uncompressed data (read on demand)
   * or {data} for data inside a compressed cluster.
   */
  Archive.prototype._locate = async function (e) {
    e = await this.resolve(e);
    if (e.isSpecial || e.cluster === undefined) throw ZimError('NOT_FOUND', 'Entry has no content.');
    var ci = await this._clusterInfo(e.cluster);
    var os = ci.offsetSize, n = e.blob;
    if (ci.compression <= 1) {
      var o = await this._read(ci.start + 1 + n * os, 2 * os);
      var bs = os === 8 ? u64(o, 0) : u32(o, 0);
      var be = os === 8 ? u64(o, os) : u32(o, os);
      return { offset: ci.start + 1 + bs, size: be - bs };
    }
    var d = await this._decompressedCluster(e.cluster, ci);
    var s = os === 8 ? u64(d, n * os) : u32(d, n * os);
    var t = os === 8 ? u64(d, (n + 1) * os) : u32(d, (n + 1) * os);
    return { data: d.subarray(s, t) };
  };

  /** Returns the entry's content as a Uint8Array. */
  Archive.prototype.getContent = async function (e) {
    var loc = await this._locate(e);
    return loc.data || this._read(loc.offset, loc.size);
  };

  Archive.prototype.getText = async function (e) {
    return utf8.decode(await this.getContent(e));
  };

  // ---------- Metadata ----------

  Archive.prototype.getMetadata = async function (name) {
    var e = await this.findPath('M/' + name);
    if (!e) return null;
    try { return (await this.getText(e)).trim(); } catch (err) { return null; }
  };

  /** Book icon as {mimeType, data} or null. */
  Archive.prototype.getIllustration = async function () {
    var candidates = ['M/Illustration_48x48@1', '-/favicon', 'I/favicon.png', '-/favicon.png'];
    for (var i = 0; i < candidates.length; i++) {
      var e = await this.findPath(candidates[i]);
      if (!e) continue;
      try {
        e = await this.resolve(e);
        return { mimeType: e.mimeType || 'image/png', data: await this.getContent(e) };
      } catch (err) { /* try next */ }
    }
    return null;
  };

  // ---------- Title search ----------

  /** Picks the best title-ordered list this archive offers. */
  Archive.prototype._getTitleIndex = async function () {
    if (this._titleIndex) return this._titleIndex;
    var self = this, ti = null;
    if (this.newScheme) {
      // Front articles only (no images/scripts), sorted by title.
      var l = await this.findPath('X/listing/titleOrdered/v1');
      if (l) {
        var loc = await this._locate(l);
        if (loc.data) {
          var d = loc.data;
          ti = { count: d.length / 4, at: function (i) { return Promise.resolve(u32(d, i * 4)); }, ns: null };
        } else {
          ti = { count: loc.size / 4, at: function (i) { return self._read(loc.offset + 4 * i, 4).then(function (b) { return u32(b, 0); }); }, ns: null };
        }
      }
    }
    if (!ti) {
      // Older archives: header title list covers every entry, sorted by namespace then title.
      ti = {
        count: this.entryCount,
        at: function (i) { return self._read(self.titlePtrPos + 4 * i, 4).then(function (b) { return u32(b, 0); }); },
        ns: this.newScheme ? 'C' : 'A'
      };
    }
    // Remember title-list lookups: the first steps of every binary search hit the same spots.
    var rawAt = ti.at, atCache = new Map();
    ti.at = function (i) {
      var v = atCache.get(i);
      if (v === undefined) {
        if (atCache.size > 50000) atCache.clear();
        v = rawAt(i);
        atCache.set(i, v);
      }
      return v;
    };
    this._titleIndex = ti;
    return ti;
  };

  Archive.prototype.frontArticleCount = async function () {
    var ti = await this._getTitleIndex();
    return ti.ns ? null : ti.count;
  };

  /** Entries whose title starts with `prefix` (case-sensitive, byte order). */
  Archive.prototype.titlePrefix = function (prefix, limit) {
    this._prefixCache = this._prefixCache || new Map();
    var k = limit + '|' + prefix, hit = this._prefixCache.get(k);
    if (hit) return hit;
    if (this._prefixCache.size > 300) this._prefixCache.clear();
    hit = this._titlePrefix(prefix, limit);
    this._prefixCache.set(k, hit);
    return hit;
  };

  Archive.prototype._titlePrefix = async function (prefix, limit) {
    var ti = await this._getTitleIndex();
    var ns = ti.ns || '';
    var key = enc.encode(ns + prefix);
    var self = this;
    var keyOf = function (e) { return enc.encode((ns ? e.ns : '') + e.title); };
    var entryAtTitle = function (n) { return ti.at(n).then(function (x) { return self.entryAt(x); }); };
    var lo = await lowerBound(ti.count, function (n) {
      return entryAtTitle(n).then(function (e) { return cmpBytes(keyOf(e), key) < 0; });
    });
    var out = [];
    // Read the following titles in parallel batches until one stops matching.
    for (var start = lo, batch = limit; start < ti.count && out.length < limit && start - lo < limit * 8; start += batch) {
      var idx = [];
      for (var i = start; i < Math.min(start + batch, ti.count); i++) idx.push(i);
      var ents = await Promise.all(idx.map(entryAtTitle));
      for (var k = 0; k < ents.length; k++) {
        var en = ents[k];
        if (!startsWithBytes(keyOf(en), key)) return out;
        if (ns && !en.isRedirect && !/html/.test(en.mimeType || '')) continue;
        if (out.length < limit) out.push(en);
      }
    }
    return out;
  };

  var STOP = new Set(('a an and are as at be by can do does for from get got has have how i if in into is it its ' +
    'me my of on or should so that the this to was what when where which who why will with you your').split(' '));

  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function titleCase(s) { return s.split(' ').map(cap).join(' '); }
  function variants(s) {
    var l = s.toLowerCase();
    var v = [s, cap(s), l, cap(l), titleCase(l)];
    if (s.length <= 5) v.push(s.toUpperCase()); // short words may be acronyms (CPR, DNA)
    return v;
  }

  /**
   * Forgiving title search: tries the whole phrase and each meaningful word in several
   * capitalisations, then ranks titles that match more of the query higher.
   */
  Archive.prototype.searchTitles = async function (query, limit) {
    limit = limit || 20;
    query = String(query || '').trim().replace(/\s+/g, ' ');
    if (!query) return [];
    var ql = query.toLowerCase();
    var words = ql.split(' ').filter(function (w) { return w.length > 1 && !STOP.has(w); });
    var prefixes = new Set(variants(query));
    if (query.indexOf(' ') > 0) variants(query.replace(/ /g, '')).forEach(function (v) { prefixes.add(v); });
    if (words.length > 1 || (words.length === 1 && words[0] !== ql)) {
      words.forEach(function (w) { variants(w).forEach(function (v) { prefixes.add(v); }); });
    }
    var self = this;
    var mem = await this._memoryTitles();
    if (mem) return scoreAndDedupe(this, mem.filter(function (x) {
      var t = x.title.toLowerCase();
      return t.indexOf(ql) >= 0 || words.some(function (w) { return t.indexOf(w) >= 0; });
    }), ql, words, limit);
    var lists = await Promise.all(Array.from(prefixes).map(function (p) { return self.titlePrefix(p, 15); }));
    var found = new Map();
    lists.forEach(function (list) { list.forEach(function (e) { found.set(e.index, { entry: e, title: e.title }); }); });
    return scoreAndDedupe(this, Array.from(found.values()), ql, words, limit);
  };

  async function scoreAndDedupe(archive, items, ql, words, limit) {
    var scored = [];
    items.forEach(function (x) {
      var e = x.entry;
      var t = x.title.toLowerCase();
      var tokens = t.split(/[\s_()\-,.:;'"]+/);
      var s = 0;
      if (t === ql) s += 1000;
      else if (t.indexOf(ql) === 0) s += 400;
      words.forEach(function (w) {
        if (tokens.indexOf(w) >= 0) s += 80;
        else if (t.indexOf(w) >= 0) s += 40;
      });
      s -= t.length * 0.5;
      if (e.isRedirect) s -= 5;
      scored.push({ entry: e, title: x.title, score: s });
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    // Several titles often redirect to the same page ("Ohms law", "Ohm's Law"...): keep the best one,
    // shown under the real page's title.
    var out = [], seen = new Set();
    for (var i = 0; i < scored.length && out.length < limit; i++) {
      var r = scored[i], target = r.entry;
      try { target = await archive.resolve(r.entry); } catch (err) { continue; }
      if (seen.has(target.index)) continue;
      seen.add(target.index);
      out.push({ entry: target, title: r.entry.isRedirect ? target.title : r.title, score: r.score });
    }
    return out;
  }

  function prettyFromPath(path) {
    var parts = path.split('/').filter(Boolean);
    var last = parts.pop() || '';
    last = last.replace(/\.(html?|php|aspx?)$/i, '');
    if (/^(index|default|home)$/i.test(last) && parts.length) last = parts.pop();
    try { last = decodeURIComponent(last); } catch (e) { /* keep */ }
    last = last.replace(/[_\-+]+/g, ' ').trim();
    return last ? cap(last) : path;
  }

  /** Website copies have no real titles, so small ones get a readable title list kept in memory. */
  Archive.prototype._memoryTitles = async function () {
    if (!this.isWebsiteCopy) return null;
    if (this._mem) return this._mem;
    var ti = await this._getTitleIndex();
    if (ti.ns || ti.count > 20000) return null;
    var list = [];
    for (var i = 0; i < ti.count; i++) {
      var e = await this.entryAt(await ti.at(i));
      var title = (e.title && e.title !== e.path) ? e.title : prettyFromPath(e.path);
      list.push({ entry: e, title: title });
    }
    // Website pages usually share a prefix like "Site name — "; drop it so results read cleanly.
    var counts = {};
    list.forEach(function (x) {
      var m = /^(.{1,40}?)\s+[—–|·:-]\s+/.exec(x.title);
      if (m) counts[m[0]] = (counts[m[0]] || 0) + 1;
    });
    Object.keys(counts).forEach(function (pre) {
      if (counts[pre] < list.length * 0.4) return;
      list.forEach(function (x) { if (x.title.indexOf(pre) === 0 && x.title.length > pre.length) x.title = cap(x.title.slice(pre.length)); });
    });
    this._mem = list;
    return list;
  };

  // ---------- Book summary for the library shelf ----------

  Archive.prototype.describe = async function () {
    var self = this;
    var keys = ['Title', 'Description', 'Language', 'Date', 'Creator', 'Publisher', 'Tags', 'Scraper', 'Counter', 'Source'];
    var vals = await Promise.all(keys.map(function (k) { return self.getMetadata(k); }));
    var m = {};
    keys.forEach(function (k, i) { m[k] = vals[i]; });
    var count = await this.frontArticleCount().catch(function () { return null; });
    if (count == null && m.Counter) {
      count = 0;
      m.Counter.split(';').forEach(function (part) {
        var kv = part.split('=');
        if (/^text\/html/.test(kv[0])) count += parseInt(kv[kv.length - 1], 10) || 0;
      });
    }
    var main = await this.mainEntry().catch(function () { return null; });
    var mainPath = main ? main.fullPath : null;
    var isWebsiteCopy = /warc2zim|zimit/i.test(m.Scraper || '') || /(^|;)_sw:yes/.test(m.Tags || '');
    // Website-capture ZIMs (Zimit v1) start on a script-only loader page; jump to the real first page.
    if (main && isWebsiteCopy && /html/.test(main.mimeType || '')) {
      try {
        var html = await this.getText(main);
        var mu = /window\.mainUrl\s*=\s*["']([^"']+)["']/.exec(html);
        if (mu) {
          var u = new URL(mu[1]);
          var base = main.fullPath.slice(0, main.fullPath.lastIndexOf('/') + 1); // e.g. "C/A/"
          var p = base + u.host + decodeURIComponent(u.pathname) + (u.search ? decodeURIComponent(u.search) : '');
          if (await this.findPath(p)) { mainPath = p; this.siteBase = base; }
        }
      } catch (err) { /* keep default */ }
    }
    this.isWebsiteCopy = isWebsiteCopy;
    return {
      title: m.Title || this.name.replace(/\.zim$/i, '').replace(/[_-]+/g, ' '),
      description: m.Description || '',
      language: m.Language || '',
      date: m.Date || '',
      creator: m.Creator || '',
      publisher: m.Publisher || '',
      tags: m.Tags || '',
      source: m.Source || '',
      articleCount: count,
      mainPath: mainPath,
      isWebsiteCopy: isWebsiteCopy
    };
  };

  root.Zim = { Archive: Archive, ZimError: ZimError };
})(typeof self !== 'undefined' ? self : this);
