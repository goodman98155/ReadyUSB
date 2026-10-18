/*
 * ReadyUSB — map.js
 * Shows map books (ZIMs made by openZIM's maps2zim) with MapLibre GL. The ZIM's own map page can't
 * run from file:// (it needs fetch and ES modules), so this file draws the map itself and hands
 * MapLibre the styles, tiles, fonts and icons straight from the book through a "zim://" protocol.
 * MapLibre (viewer/vendor/maplibre-gl.js, about 1 MB) is loaded the first time a map opens.
 *
 * Part of ReadyUSB. MIT License — see viewer/LICENSE.txt
 */
(function (root) {
  'use strict';

  var LIBRARY_JS = 'viewer/vendor/maplibre-gl.js';
  var LIBRARY_CSS = 'viewer/vendor/maplibre-gl.css';
  var PROTOCOL = 'zim';
  var utf8 = new TextDecoder('utf-8');

  var libraryPromise = null;
  var protocolAdded = false;
  var rtlPluginSet = false;
  var archive = null;     // the open map book; the protocol reads from it
  var current = null;     // {map, config, darkQuery, onTheme}
  var generation = 0;     // bumped by close(), so a map still loading after close() is thrown away

  function mapError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  function safeDecode(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }

  /** True when the archive is a maps2zim book: it has the map settings and the tile index. */
  async function isMapBook(a) {
    if (!a.newScheme) return false;
    var found = await Promise.all(['C/content/config.json', 'C/planet'].map(function (p) { return a.findPath(p); }));
    return !!(found[0] && found[1]);
  }

  /** MapLibre 5 needs WebGL 2. */
  function canDrawMaps() {
    try {
      return !!(root.WebGL2RenderingContext && document.createElement('canvas').getContext('webgl2'));
    } catch (e) { return false; }
  }

  function loadLibrary() {
    if (root.maplibregl) return Promise.resolve(root.maplibregl);
    if (!libraryPromise) {
      libraryPromise = new Promise(function (resolve, reject) {
        var css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = LIBRARY_CSS;
        document.head.appendChild(css);
        var s = document.createElement('script');
        s.src = LIBRARY_JS;
        s.onload = function () {
          if (root.maplibregl) resolve(root.maplibregl);
          else reject(mapError('NO_LIBRARY', 'MapLibre did not load.'));
        };
        s.onerror = function () { reject(mapError('NO_LIBRARY', 'Could not load ' + LIBRARY_JS + '.')); };
        document.head.appendChild(s);
      });
      libraryPromise.catch(function () { libraryPromise = null; });
    }
    return libraryPromise;
  }

  // ---------------------------------------------------------------- reading from the book

  /** "zim://tiles/3/4/2.pbf" → "C/tiles/3/4/2.pbf" */
  function zimPath(url) {
    var p = url.slice(PROTOCOL.length + 3).split(/[?#]/)[0];
    return 'C/' + p.split('/').map(safeDecode).join('/');
  }

  /** "./planet" (relative to the ZIM's map page) → "zim://planet"; other addresses are left alone. */
  function toZimUrl(u) {
    if (typeof u !== 'string' || /^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
    return PROTOCOL + '://' + u.replace(/^\.?\/+/, '');
  }

  async function readBytes(path) {
    var e = archive && await archive.findPath(path);
    if (!e) return null;
    return archive.getContent(await archive.resolve(e));
  }

  async function readJson(path) {
    var bytes = await readBytes(path);
    return bytes ? JSON.parse(utf8.decode(bytes)) : null;
  }

  /** MapLibre asks for every style file, tile, font and icon through here. */
  async function handleRequest(params) {
    var path = zimPath(params.url);
    var bytes = await readBytes(path);
    if (!bytes) {
      // Tiles outside the area the map covers and missing font ranges: an empty answer just draws nothing.
      if (/\.pbf$/i.test(path)) return { data: new ArrayBuffer(0) };
      throw mapError('NOT_FOUND', 'Not in this map: ' + path);
    }
    if (params.type === 'json') return { data: JSON.parse(utf8.decode(bytes)) };
    if (params.type === 'string') return { data: utf8.decode(bytes) };
    // Copy: the bytes may be a view into a cached cluster, and MapLibre hands buffers to its workers.
    return { data: bytes.slice().buffer };
  }

  // ---------------------------------------------------------------- style

  function prefersDark() {
    return !!(root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  /** The book's light or dark style, with every address pointed into the book. */
  async function loadStyle(dark) {
    var style = (dark && await readJson('C/assets/kiwix-dark')) || await readJson('C/assets/kiwix-light');
    if (!style) throw mapError('NO_STYLE', 'This map has no style.');
    if (style.glyphs) style.glyphs = toZimUrl(style.glyphs);
    if (typeof style.sprite === 'string') style.sprite = toZimUrl(style.sprite);
    else if (Array.isArray(style.sprite)) style.sprite.forEach(function (s) { s.url = toZimUrl(s.url); });
    var sources = style.sources || {};
    var names = Object.keys(sources);
    for (var i = 0; i < names.length; i++) {
      var src = sources[names[i]];
      if (Array.isArray(src.tiles)) src.tiles = src.tiles.map(toZimUrl);
      if (typeof src.data === 'string') src.data = toZimUrl(src.data);
      if (typeof src.url === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(src.url)) {
        // Read the TileJSON ourselves and put it in the style, so its relative tile address resolves here.
        var tj = await readJson(zimPath(toZimUrl(src.url)));
        if (tj) {
          delete src.url;
          src.tiles = (tj.tiles || []).map(toZimUrl);
          ['minzoom', 'maxzoom', 'bounds', 'attribution', 'scheme'].forEach(function (k) {
            if (tj[k] !== undefined && src[k] === undefined) src[k] = tj[k];
          });
        }
      }
    }
    return style;
  }

  // ---------------------------------------------------------------- the map

  function validView(v) {
    return v && isFinite(v.lat) && isFinite(v.lon) && isFinite(v.zoom) &&
      Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180 && v.zoom >= 0 && v.zoom <= 24;
  }

  function homeView(map, config) {
    if (config.center && config.zoom !== undefined) {
      map.flyTo({ center: config.center, zoom: config.zoom, duration: 1000 });
    } else if (config.boundingBox) {
      map.fitBounds(config.boundingBox, { duration: 1000 });
    } else {
      map.flyTo({ center: [0, 20], zoom: 1, duration: 1000 });
    }
  }

  /** A "back to the start" button in MapLibre's control style. */
  function HomeControl(onClick) { this.onClick = onClick; }
  HomeControl.prototype.onAdd = function () {
    var box = document.createElement('div');
    box.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'map-home-button';
    b.title = 'Back to the start of this map';
    b.setAttribute('aria-label', b.title);
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11l8-7 8 7M6 9.5V20h12V9.5"/></svg>';
    b.addEventListener('click', this.onClick);
    box.appendChild(b);
    this.box = box;
    return box;
  };
  HomeControl.prototype.onRemove = function () { this.box.remove(); };

  function usesMiles() {
    return /^en-(US|LR|MM)$/i.test(navigator.language || '');
  }

  /**
   * Draws the map book in `container`.
   * opts.view: {lat, lon, zoom} to start at (else the book's default view).
   * opts.onMove(view): called after the map stops moving.
   */
  async function show(container, a, opts) {
    opts = opts || {};
    close();
    var gen = generation;
    if (!canDrawMaps()) throw mapError('NO_WEBGL', 'WebGL 2 is not available.');
    var ml = await loadLibrary();
    if (!protocolAdded) { ml.addProtocol(PROTOCOL, handleRequest); protocolAdded = true; }
    archive = a;
    var config = (await readJson('C/content/config.json')) || {};
    var dark = prefersDark();
    var style = await loadStyle(dark);
    if (!rtlPluginSet) {
      // Right-to-left labels (Arabic, Hebrew) need a plugin the book carries; it loads only if needed.
      var rtl = await readBytes('C/assets/mapbox-gl-rtl-text.js').catch(function () { return null; });
      if (rtl) {
        rtlPluginSet = true;
        var rtlUrl = URL.createObjectURL(new Blob([rtl], { type: 'text/javascript' }));
        ml.setRTLTextPlugin(rtlUrl, true).catch(function (err) { console.warn('Right-to-left plugin failed', err); });
      }
    }
    if (gen !== generation) throw mapError('CANCELLED', 'Closed while loading.');

    var start = validView(opts.view) ? { center: [opts.view.lon, opts.view.lat], zoom: opts.view.zoom }
      : config.center ? { center: config.center, zoom: config.zoom !== undefined ? config.zoom : 4 }
      : { center: [0, 20], zoom: 1 };
    var map;
    try {
      map = new ml.Map({
        container: container,
        style: style,
        center: start.center,
        zoom: start.zoom,
        maxZoom: config.maxZoom !== undefined ? config.maxZoom : 18,
        maxBounds: config.boundingBox || undefined,
        // Keep north up: turning or tilting the map by accident confuses more than it helps.
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        attributionControl: { compact: true }
      });
    } catch (err) {
      throw mapError('NO_WEBGL', err && err.message);
    }
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    if (!validView(opts.view) && !config.center && config.boundingBox) map.fitBounds(config.boundingBox, { duration: 0 });

    current = { map: map, config: config };
    map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-right');
    map.addControl(new HomeControl(function () { homeView(map, config); }), 'top-right');
    var scale = new ml.ScaleControl({ unit: usesMiles() ? 'imperial' : 'metric' });
    map.addControl(scale, 'bottom-left');
    var scaleBox = container.querySelector('.maplibregl-ctrl-scale');
    if (scaleBox) {
      scaleBox.title = 'Switch between miles and kilometres';
      scaleBox.style.cursor = 'pointer';
      scaleBox.style.pointerEvents = 'auto';
      scaleBox.addEventListener('click', function () { scale.setUnit(scale.options.unit === 'metric' ? 'imperial' : 'metric'); });
    }

    if (opts.onMove) {
      map.on('moveend', function () {
        var c = map.getCenter();
        opts.onMove({ lat: c.lat, lon: c.lng, zoom: map.getZoom() });
      });
    }

    // Follow the computer's light or dark setting while the map is open.
    if (root.matchMedia) {
      current.darkQuery = root.matchMedia('(prefers-color-scheme: dark)');
      current.onTheme = function () {
        loadStyle(prefersDark()).then(function (s) { if (current && current.map === map) map.setStyle(s); })
          .catch(function (err) { console.warn('Could not switch map style', err); });
      };
      current.darkQuery.addEventListener('change', current.onTheme);
    }

    await new Promise(function (resolve, reject) {
      var done = false;
      map.once('load', function () { done = true; resolve(); });
      map.on('error', function (ev) {
        // One missing tile or icon isn't fatal; the map keeps drawing what it has.
        console.warn('Map:', ev && ev.error ? ev.error.message || ev.error : ev);
      });
      setTimeout(function () {
        if (!done) reject(mapError('TIMEOUT', 'The map took too long to load.'));
      }, 30000);
    });
    if (gen !== generation) throw mapError('CANCELLED', 'Closed while loading.');
    return map;
  }

  /** Moves the open map to a view, e.g. after Back or Forward. */
  function setView(view) {
    if (current && validView(view)) current.map.jumpTo({ center: [view.lon, view.lat], zoom: view.zoom });
  }

  function goHome() {
    if (current) homeView(current.map, current.config);
  }

  /** Removes the map and frees its graphics memory. Safe to call when no map is open. */
  function close() {
    generation++;
    if (!current) return;
    if (current.darkQuery) current.darkQuery.removeEventListener('change', current.onTheme);
    try { current.map.remove(); } catch (e) { /* already gone */ }
    current = null;
  }

  root.ReadyMap = {
    isMapBook: isMapBook,
    canDrawMaps: canDrawMaps,
    show: show,
    setView: setView,
    goHome: goHome,
    close: close
  };
})(typeof self !== 'undefined' ? self : this);
