/**
 * ============================================================================
 * PEMS PWA — CLIENT-SIDE OFFLINE STORAGE ENGINE (IndexedDB)
 * File: js/db.js
 * ============================================================================
 * Provides persistent offline storage for:
 * 1. 'records'   - 20-column asset and property records
 * 2. 'photos'    - Equipment photos and PDF document binary blobs
 * 3. 'syncQueue' - Durable mutation queue for offline creates, updates, and deletes
 * 4. 'metadata'  - Session, cached stats, uploaders, and API configuration
 */

(function(window) {
  'use strict';

  const DB_NAME = 'pems_offline_db';
  const DB_VERSION = 1;

  let dbInstance = null;
  let initPromise = null;

  const PEMS_DB = {
    /**
     * Initializes the IndexedDB database and object stores.
     * @returns {Promise<IDBDatabase>}
     */
    init() {
      if (dbInstance) return Promise.resolve(dbInstance);
      if (initPromise) return initPromise;

      initPromise = new Promise((resolve, reject) => {
        if (!window.indexedDB) {
          console.warn('IndexedDB is not supported in this browser environment.');
          return reject(new Error('IndexedDB not supported'));
        }

        const request = window.indexedDB.open(DB_NAME, DB_VERSION);

        request.onupgradeneeded = (event) => {
          const db = event.target.result;

          // 1. Records Store (Key: Property No in uppercase)
          if (!db.objectStoreNames.contains('records')) {
            const recordStore = db.createObjectStore('records', { keyPath: 'propertyNo' });
            recordStore.createIndex('tier', 'tier', { unique: false });
            recordStore.createIndex('syncStatus', 'syncStatus', { unique: false });
            recordStore.createIndex('uploadedBy', 'uploadedBy', { unique: false });
            recordStore.createIndex('clientUpdatedAt', 'clientUpdatedAt', { unique: false });
          }

          // 2. Photos Store (Binary blobs / base64 for offline images & docs)
          if (!db.objectStoreNames.contains('photos')) {
            const photoStore = db.createObjectStore('photos', { keyPath: 'photoId' });
            photoStore.createIndex('propertyNo', 'propertyNo', { unique: false });
            photoStore.createIndex('docType', 'docType', { unique: false });
          }

          // 3. Durable Sync Queue Store
          if (!db.objectStoreNames.contains('syncQueue')) {
            const queueStore = db.createObjectStore('syncQueue', { keyPath: 'id', autoIncrement: true });
            queueStore.createIndex('status', 'status', { unique: false });
            queueStore.createIndex('idempotencyKey', 'idempotencyKey', { unique: true });
            queueStore.createIndex('createdAt', 'createdAt', { unique: false });
          }

          // 4. Metadata Store (Key-value pairs)
          if (!db.objectStoreNames.contains('metadata')) {
            db.createObjectStore('metadata', { keyPath: 'key' });
          }
        };

        request.onsuccess = (event) => {
          dbInstance = event.target.result;
          resolve(dbInstance);
        };

        request.onerror = (event) => {
          console.error('Failed to open IndexedDB:', event.target.error);
          reject(event.target.error);
        };
      });

      return initPromise;
    },

    /**
     * Executes a transaction on the specified store.
     * @private
     */
    _getTransaction(storeName, mode = 'readonly') {
      return this.init().then(db => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        return { tx, store };
      });
    },

    // =========================================================================
    // RECORDS STORE METHODS
    // =========================================================================

    /**
     * Saves or updates a single record in IndexedDB.
     */
    saveRecord(record) {
      if (!record) return Promise.reject(new Error('Record is required'));
      const pNo = String(record.propertyNo || (record.rowValues && record.rowValues[1]) || '').trim().toUpperCase();
      if (!pNo) return Promise.reject(new Error('Property No is required'));

      record.propertyNo = pNo;
      record.clientUpdatedAt = record.clientUpdatedAt || new Date().toISOString();
      record.syncStatus = record.syncStatus || 'synced'; // 'synced' | 'pending' | 'failed'

      return this._getTransaction('records', 'readwrite').then(({ store, tx }) => {
        return new Promise((resolve, reject) => {
          const req = store.put(record);
          req.onsuccess = () => resolve(record);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Retrieves a single record by Property No.
     */
    getRecord(propertyNo) {
      const pNo = String(propertyNo || '').trim().toUpperCase();
      if (!pNo) return Promise.resolve(null);

      return this._getTransaction('records', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.get(pNo);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Retrieves all records stored in IndexedDB.
     */
    getAllRecords() {
      return this._getTransaction('records', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Deletes a record from IndexedDB by Property No.
     */
    deleteRecord(propertyNo) {
      const pNo = String(propertyNo || '').trim().toUpperCase();
      if (!pNo) return Promise.resolve(false);

      return this._getTransaction('records', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.delete(pNo);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Bulk saves an array of records in a single transaction.
     */
    saveRecordsBatch(records) {
      if (!Array.isArray(records) || records.length === 0) return Promise.resolve(0);

      return this._getTransaction('records', 'readwrite').then(({ store, tx }) => {
        return new Promise((resolve, reject) => {
          let count = 0;
          records.forEach(rec => {
            const pNo = String(rec.propertyNo || (rec.rowValues && rec.rowValues[1]) || '').trim().toUpperCase();
            if (pNo) {
              rec.propertyNo = pNo;
              rec.clientUpdatedAt = rec.clientUpdatedAt || new Date().toISOString();
              rec.syncStatus = rec.syncStatus || 'synced';
              store.put(rec);
              count++;
            }
          });
          tx.oncomplete = () => resolve(count);
          tx.onerror = () => reject(tx.error);
        });
      });
    },

    /**
     * Clears all records from IndexedDB.
     */
    clearRecords() {
      return this._getTransaction('records', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.clear();
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      });
    },

    // =========================================================================
    // PHOTOS STORE METHODS
    // =========================================================================

    /**
     * Saves a photo or document blob in IndexedDB.
     */
    savePhotoBlob(photoId, blobOrBase64, metadata = {}) {
      const id = String(photoId || '').trim();
      if (!id) return Promise.reject(new Error('Photo ID is required'));

      const entry = {
        photoId: id,
        propertyNo: metadata.propertyNo || '',
        docType: metadata.docType || 'photo',
        data: blobOrBase64,
        mimeType: metadata.mimeType || 'image/jpeg',
        fileName: metadata.fileName || (id + '.jpg'),
        fileSize: metadata.fileSize || 0,
        createdAt: new Date().toISOString()
      };

      return this._getTransaction('photos', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.put(entry);
          req.onsuccess = () => resolve(entry);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Retrieves a photo or document blob by Photo ID.
     */
    getPhotoBlob(photoId) {
      const id = String(photoId || '').trim();
      if (!id) return Promise.resolve(null);

      return this._getTransaction('photos', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Deletes a photo blob by Photo ID.
     */
    deletePhotoBlob(photoId) {
      const id = String(photoId || '').trim();
      if (!id) return Promise.resolve(false);

      return this._getTransaction('photos', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.delete(id);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      });
    },

    // =========================================================================
    // DURABLE SYNC QUEUE METHODS
    // =========================================================================

    /**
     * Enqueues an offline mutation into the sync queue.
     * @param {string} action E.g. 'ADD_MANUAL_INVENTORY', 'UPDATE_ASSET_TRACKING', 'DELETE_INVENTORY_RECORD'
     * @param {Object} payload The mutation payload
     * @param {string} [idempotencyKey] Unique idempotency key (UUID)
     * @param {string} [photoKey] Optional key linking to photo store
     */
    enqueueMutation(action, payload, idempotencyKey, photoKey = null) {
      const key = idempotencyKey || ('idem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9));

      const mutation = {
        action: action,
        payload: payload,
        idempotencyKey: key,
        photoKey: photoKey,
        status: 'pending', // 'pending' | 'syncing' | 'failed'
        retries: 0,
        lastError: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      return this._getTransaction('syncQueue', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.add(mutation);
          req.onsuccess = () => {
            mutation.id = req.result;
            resolve(mutation);
          };
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Retrieves all pending and failed mutations in the sync queue.
     */
    getPendingMutations() {
      return this._getTransaction('syncQueue', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => {
            const all = req.result || [];
            const pending = all.filter(item => item.status === 'pending' || item.status === 'failed');
            // Sort by createdAt ascending
            pending.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
            resolve(pending);
          };
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Retrieves all mutations regardless of status.
     */
    getAllMutations() {
      return this._getTransaction('syncQueue', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Updates the status and retry state of a mutation.
     */
    updateMutation(id, updates) {
      return this._getTransaction('syncQueue', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const getReq = store.get(id);
          getReq.onsuccess = () => {
            const item = getReq.result;
            if (!item) return resolve(null);
            Object.assign(item, updates, { updatedAt: new Date().toISOString() });
            const putReq = store.put(item);
            putReq.onsuccess = () => resolve(item);
            putReq.onerror = () => reject(putReq.error);
          };
          getReq.onerror = () => reject(getReq.error);
        });
      });
    },

    /**
     * Removes a successfully synced mutation from the queue.
     */
    removeMutation(id) {
      return this._getTransaction('syncQueue', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.delete(id);
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Returns statistics of the sync queue.
     */
    getSyncStats() {
      return this.getAllMutations().then(items => {
        let pending = 0;
        let syncing = 0;
        let failed = 0;
        items.forEach(it => {
          if (it.status === 'pending') pending++;
          else if (it.status === 'syncing') syncing++;
          else if (it.status === 'failed') failed++;
        });
        return {
          total: items.length,
          pending: pending,
          syncing: syncing,
          failed: failed
        };
      });
    },

    /**
     * Clears the entire sync queue.
     */
    clearSyncQueue() {
      return this._getTransaction('syncQueue', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.clear();
          req.onsuccess = () => resolve(true);
          req.onerror = () => reject(req.error);
        });
      });
    },

    // =========================================================================
    // METADATA STORE METHODS
    // =========================================================================

    /**
     * Sets a key-value pair in metadata store.
     */
    setMeta(key, value) {
      return this._getTransaction('metadata', 'readwrite').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.put({ key: key, value: value, updatedAt: new Date().toISOString() });
          req.onsuccess = () => resolve(value);
          req.onerror = () => reject(req.error);
        });
      });
    },

    /**
     * Gets a value from metadata store by key.
     */
    getMeta(key) {
      return this._getTransaction('metadata', 'readonly').then(({ store }) => {
        return new Promise((resolve, reject) => {
          const req = store.get(key);
          req.onsuccess = () => resolve(req.result ? req.result.value : null);
          req.onerror = () => reject(req.error);
        });
      });
    }
  };

  // Attach to window global object
  window.PEMS_DB = PEMS_DB;

})(typeof window !== 'undefined' ? window : this);
