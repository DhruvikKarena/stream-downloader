/**
 * Segment Storage & Decryption Module (segment-store.js)
 *
 * IndexedDB storage keyed `${downloadId}:${zero-padded index}` with put/get/clear.
 * Automatically decrypts AES-128 encrypted segments via Web Crypto API before storing.
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SegmentStore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DB_NAME = 'StreamDownloaderSegmentDB';
  const DB_VERSION = 1;
  const STORE_NAME = 'segments';

  let dbPromise = null;
  const cryptoKeyCache = new Map();

  /**
   * Open IndexedDB instance with upgrade handling.
   */
  function openDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('downloadId', 'downloadId', { unique: false });
          store.createIndex('index', 'index', { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return dbPromise;
  }

  /**
   * Zero-pad segment index to 6 digits (e.g. 000000, 000042).
   */
  function formatKey(downloadId, index) {
    const padded = String(index).padStart(6, '0');
    return `${downloadId}:${padded}`;
  }

  /**
   * Store decrypted segment data into IndexedDB.
   */
  async function putSegment(downloadId, index, buffer, meta = {}) {
    const db = await openDB();
    const id = formatKey(downloadId, index);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const entry = {
        id,
        downloadId,
        index,
        data: buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer),
        byteLength: buffer.byteLength,
        duration: meta.duration || 0,
        discontinuity: !!meta.discontinuity,
        timestamp: Date.now()
      };

      const req = store.put(entry);
      req.onsuccess = () => resolve(id);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieve a single segment by index.
   */
  async function getSegment(downloadId, index) {
    const db = await openDB();
    const id = formatKey(downloadId, index);

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id);

      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Retrieve all stored segments for a download, ordered by index.
   */
  async function getAllSegments(downloadId) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('downloadId');
      const req = index.getAll(downloadId);

      req.onsuccess = () => {
        const results = req.result || [];
        results.sort((a, b) => a.index - b.index);
        resolve(results);
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Clear all segments belonging to downloadId.
   */
  async function clearDownload(downloadId) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('downloadId');
      const req = index.openCursor(downloadId);

      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          cursor.delete();
          cursor.continue();
        } else {
          resolve(true);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  /**
   * Count total segments stored for downloadId.
   */
  async function countSegments(downloadId) {
    const db = await openDB();

    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const index = store.index('downloadId');
      const req = index.count(downloadId);

      req.onsuccess = () => resolve(req.result || 0);
      req.onerror = () => reject(req.error);
    });
  }

  // ---------------------------------------------------------------------------
  // AES-128 Decryption via Web Crypto API (AES-CBC)
  // ---------------------------------------------------------------------------

  function parseHexIv(hexStr) {
    const clean = hexStr.startsWith('0x') || hexStr.startsWith('0X') ? hexStr.slice(2) : hexStr;
    const ivBytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      ivBytes[i] = parseInt(clean.substr(i * 2, 2), 16) || 0;
    }
    return ivBytes;
  }

  async function getCryptoKey(keyUri, keyRawBuffer) {
    if (cryptoKeyCache.has(keyUri)) return cryptoKeyCache.get(keyUri);

    let raw = keyRawBuffer;
    if (!raw) {
      const res = await fetch(keyUri, { credentials: 'include' });
      if (!res.ok) throw new Error(`HTTP ${res.status} when fetching AES encryption key`);
      raw = await res.arrayBuffer();
    }

    const cryptoKey = await window.crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'AES-CBC' },
      false,
      ['decrypt']
    );

    cryptoKeyCache.set(keyUri, cryptoKey);
    return cryptoKey;
  }

  async function decryptSegmentBuffer(buffer, encryption, sequenceNumber, keyRawBuffer) {
    if (!encryption || encryption.method !== 'AES-128' || !encryption.uri) {
      return buffer;
    }

    const cryptoKey = await getCryptoKey(encryption.uri, keyRawBuffer);

    let ivBytes;
    if (encryption.iv && encryption.iv.length >= 2) {
      ivBytes = parseHexIv(encryption.iv);
    } else {
      ivBytes = new Uint8Array(16);
      const view = new DataView(ivBytes.buffer);
      // Sequence number placed in the last 4 bytes as a big-endian integer (RFC 8216)
      view.setUint32(12, sequenceNumber, false);
    }

    return await window.crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: ivBytes },
      cryptoKey,
      buffer
    );
  }

  /**
   * Decrypt segment buffer (if encrypted) and store it into IndexedDB.
   */
  async function decryptAndStore(downloadId, index, rawBuffer, encryption, sequenceNumber, meta = {}, keyRawBuffer) {
    let plainBuffer = rawBuffer;
    if (encryption && encryption.method === 'AES-128') {
      plainBuffer = await decryptSegmentBuffer(rawBuffer, encryption, sequenceNumber, keyRawBuffer);
    }
    await putSegment(downloadId, index, plainBuffer, meta);
    return plainBuffer;
  }

  return {
    openDB,
    formatKey,
    formatSegmentKey: formatKey,
    putSegment,
    getSegment,
    getAllSegments,
    clearDownload,
    countSegments,
    decryptSegmentBuffer,
    decryptAndStore,
    getCryptoKey
  };
});
