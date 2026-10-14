/**
 * ============================================================================
 * PEMS PWA — DURABLE SYNCHRONIZATION ENGINE
 * File: js/sync.js
 * ============================================================================
 * Handles bidirectional synchronization between IndexedDB and Google Apps Script:
 * - Auto-sync on app launch, 'online' reconnection, visibilitychange, and manual Sync Now
 * - Connectivity health-check (never assumes navigator.onLine guarantees backend availability)
 * - Exponential backoff retry logic for transient network failures
 * - Idempotency key preservation to guarantee zero duplicate records or uploads
 * - Partial failure isolation (individual failures never block remaining items)
 * - Real-time sync status badges: 'synced', 'pending', 'syncing', 'failed'
 */

(function(window) {
  'use strict';

  const PEMS_SYNC = {
    state: {
      isSyncing: false,
      isOnline: navigator.onLine,
      serverReachable: false,
      lastSyncTimestamp: null,
      pendingCount: 0,
      failedCount: 0,
      syncingCount: 0,
      retryTimer: null,
      syncDrawerOpen: false
    },

    listeners: [],

    /**
     * Initializes the Sync Engine and binds event listeners.
     */
    init() {
      // 1. Listen for browser online / offline network events
      window.addEventListener('online', () => {
        console.log('[PEMS Sync] Network connection restored (online event).');
        this.state.isOnline = true;
        this.updateSyncBadge();
        this.triggerSync('network_reconnected');
      });

      window.addEventListener('offline', () => {
        console.log('[PEMS Sync] Network connection lost (offline event).');
        this.state.isOnline = false;
        this.state.serverReachable = false;
        this.updateSyncBadge();
      });

      // 2. Listen for tab / app visibility changes (e.g. user returns to app)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          console.log('[PEMS Sync] App returned to foreground (visibilitychange).');
          this.triggerSync('visibility_change');
        }
      });

      // 3. Update initial queue stats & badge
      this.refreshQueueStats();

      // 4. Initial connectivity test & sync trigger after DOM ready
      setTimeout(() => {
        this.triggerSync('app_launch');
      }, 1500);

      // 5. Periodic background heartbeat sync check (every 2 minutes)
      setInterval(() => {
        if (!this.state.isSyncing && (this.state.pendingCount > 0 || this.state.failedCount > 0)) {
          this.triggerSync('periodic_heartbeat');
        }
      }, 120000);
    },

    /**
     * Generates a collision-resistant UUID / Idempotency Key.
     * @returns {string}
     */
    generateIdempotencyKey() {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
      return 'idem_' + Date.now() + '_' + Math.random().toString(36).substring(2, 10);
    },

    /**
     * Subscribes a listener to sync state updates.
     */
    onStateChange(callback) {
      if (typeof callback === 'function') {
        this.listeners.push(callback);
      }
    },

    notifyListeners() {
      this.listeners.forEach(cb => {
        try { cb(this.state); } catch (e) { console.warn(e); }
      });
    },

    /**
     * Verifies that the Google Apps Script backend is actually reachable.
     * Crucial: Does NOT assume navigator.onLine means the backend is available.
     * @returns {Promise<boolean>}
     */
    async checkConnectivity() {
      if (!navigator.onLine) {
        this.state.serverReachable = false;
        return false;
      }

      const apiUrl = (window.PEMS_CONFIG && window.PEMS_CONFIG.getApiUrl) ? window.PEMS_CONFIG.getApiUrl() : '';
      if (!apiUrl) {
        // In local preview/test mode without configured URL
        this.state.serverReachable = false;
        return false;
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 6000);

        // Ping backend using GET ?action=ping
        const pingUrl = apiUrl + (apiUrl.indexOf('?') !== -1 ? '&' : '?') + 'action=ping&_t=' + Date.now();
        const response = await fetch(pingUrl, {
          method: 'GET',
          mode: 'cors',
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          const json = await response.json().catch(() => null);
          this.state.serverReachable = (json && json.success === true);
          return this.state.serverReachable;
        }
        this.state.serverReachable = false;
        return false;
      } catch (err) {
        // Backend unreachable, captive portal, DNS resolution error, or CORS timeout
        this.state.serverReachable = false;
        return false;
      }
    },

    /**
     * Triggers sync if not already running.
     * @param {string} [triggerSource='manual']
     */
    async triggerSync(triggerSource = 'manual') {
      if (this.state.isSyncing) {
        console.log('[PEMS Sync] Sync already in progress, skipping trigger from:', triggerSource);
        return;
      }

      await this.refreshQueueStats();
      if (this.state.pendingCount === 0 && this.state.failedCount === 0) {
        // Nothing to sync
        return;
      }

      this.syncNow(triggerSource);
    },

    /**
     * Executes the full synchronization workflow.
     */
    async syncNow(triggerSource = 'manual') {
      if (this.state.isSyncing) return;

      this.state.isSyncing = true;
      this.updateSyncBadge();

      console.log(`[PEMS Sync] Starting synchronization (Source: ${triggerSource})...`);

      try {
        // 1. Verify actual backend connectivity
        const isReachable = await this.checkConnectivity();
        if (!isReachable) {
          console.warn('[PEMS Sync] Backend is currently unreachable. Sync paused until connectivity is verified.');
          this.state.isSyncing = false;
          this.updateSyncBadge();
          if (triggerSource === 'manual' && window.PEMS && window.PEMS.notification) {
            window.PEMS.notification.warning('Sync Paused', 'Backend server is currently unreachable. Changes are saved safely in offline storage.');
          }
          return;
        }

        // 2. Fetch pending mutations from IndexedDB
        if (!window.PEMS_DB) {
          throw new Error('IndexedDB offline storage is not initialized.');
        }

        const pendingMutations = await window.PEMS_DB.getPendingMutations();
        if (pendingMutations.length === 0) {
          this.state.isSyncing = false;
          await this.refreshQueueStats();
          return;
        }

        let syncSuccessCount = 0;
        let syncFailureCount = 0;

        // 3. Process each mutation sequentially with error isolation
        for (let i = 0; i < pendingMutations.length; i++) {
          const mutation = pendingMutations[i];

          // Mark mutation as syncing
          await window.PEMS_DB.updateMutation(mutation.id, { status: 'syncing' });
          this.updateSyncBadge();

          try {
            const result = await this.dispatchMutation(mutation);

            if (result && result.success) {
              // Mutation succeeded!
              syncSuccessCount++;

              // Update local record syncStatus to 'synced'
              if (mutation.payload && mutation.payload.propertyNo) {
                const localRec = await window.PEMS_DB.getRecord(mutation.payload.propertyNo);
                if (localRec) {
                  localRec.syncStatus = 'synced';
                  await window.PEMS_DB.saveRecord(localRec);
                }
              }

              // Clean up linked photo blob if present
              if (mutation.photoKey) {
                await window.PEMS_DB.deletePhotoBlob(mutation.photoKey).catch(() => {});
              }

              // Remove mutation from syncQueue
              await window.PEMS_DB.removeMutation(mutation.id);
            } else {
              // Mutation failed on server
              syncFailureCount++;
              const errMsg = (result && result.message) || 'Unknown server rejection';
              const newRetries = (mutation.retries || 0) + 1;
              await window.PEMS_DB.updateMutation(mutation.id, {
                status: 'failed',
                retries: newRetries,
                lastError: errMsg
              });

              if (mutation.payload && mutation.payload.propertyNo) {
                const localRec = await window.PEMS_DB.getRecord(mutation.payload.propertyNo);
                if (localRec) {
                  localRec.syncStatus = 'failed';
                  await window.PEMS_DB.saveRecord(localRec);
                }
              }
            }
          } catch (itemErr) {
            syncFailureCount++;
            console.error(`[PEMS Sync] Error syncing mutation #${mutation.id}:`, itemErr);
            const newRetries = (mutation.retries || 0) + 1;
            await window.PEMS_DB.updateMutation(mutation.id, {
              status: 'failed',
              retries: newRetries,
              lastError: itemErr.message || 'Network communication error'
            });

            if (mutation.payload && mutation.payload.propertyNo) {
              const localRec = await window.PEMS_DB.getRecord(mutation.payload.propertyNo);
              if (localRec) {
                localRec.syncStatus = 'failed';
                await window.PEMS_DB.saveRecord(localRec);
              }
            }
          }
        }

        // 4. Update last sync timestamp
        this.state.lastSyncTimestamp = new Date().toISOString();
        if (window.PEMS_DB) {
          await window.PEMS_DB.setMeta('lastSyncTimestamp', this.state.lastSyncTimestamp);
        }

        // 5. Notify user if appropriate
        if (syncSuccessCount > 0 && window.PEMS && window.PEMS.notification) {
          window.PEMS.notification.success(
            'Sync Complete',
            `Successfully synchronized ${syncSuccessCount} record${syncSuccessCount > 1 ? 's' : ''} with Google Sheets & Drive.`
          );
        }

        if (syncFailureCount > 0 && window.PEMS && window.PEMS.notification) {
          window.PEMS.notification.error(
            'Sync Warning',
            `${syncFailureCount} mutation${syncFailureCount > 1 ? 's' : ''} encountered an issue. Tap the sync badge to review.`
          );
        }

        // Refresh live inventory view if visible
        if (window.PEMS && window.PEMS.inventory && typeof window.PEMS.inventory.load === 'function') {
          window.PEMS.inventory.load(true);
        }
      } catch (err) {
        console.error('[PEMS Sync] Fatal error during synchronization:', err);
      } finally {
        this.state.isSyncing = false;
        await this.refreshQueueStats();
        this.updateSyncBadge();
      }
    },

    /**
     * Dispatches an individual mutation to the backend API.
     * @private
     */
    async dispatchMutation(mutation) {
      const action = mutation.action;
      const payload = mutation.payload || {};
      const key = mutation.idempotencyKey;

      // Attach idempotencyKey to payload
      payload.idempotencyKey = key;

      // If mutation has a linked photo blob, load from IndexedDB photos store
      if (mutation.photoKey && window.PEMS_DB) {
        const photoEntry = await window.PEMS_DB.getPhotoBlob(mutation.photoKey);
        if (photoEntry && photoEntry.data) {
          if (action === 'UPDATE_ASSET_TRACKING' || action === 'updateAssetTracking') {
            const docType = photoEntry.docType || 'photo';
            const base64Data = typeof photoEntry.data === 'string' && photoEntry.data.indexOf('base64,') !== -1
              ? photoEntry.data.split('base64,')[1]
              : photoEntry.data;

            const fileObj = {
              base64: base64Data,
              mimeType: photoEntry.mimeType || 'image/jpeg',
              fileName: photoEntry.fileName || 'photo.jpg'
            };

            if (docType === 'photo' || docType === 'equipment_photo') {
              payload.equipmentPhotoFile = fileObj;
            } else if (docType === 'fets') {
              payload.fetsFile = fileObj;
            } else if (docType === 'transmittal') {
              payload.transmittalFile = fileObj;
            }
          }
        }
      }

      // Execute via PEMS.api.invoke
      if (window.PEMS && window.PEMS.api && typeof window.PEMS.api.invoke === 'function') {
        const sess = window.PEMS.session ? window.PEMS.session.get() : null;
        const sessionId = sess ? sess.sessionId : null;

        if (action === 'ADD_MANUAL_INVENTORY' || action === 'addManualInventoryRecord') {
          return window.PEMS.api.addManualInventoryRecord(payload);
        } else if (action === 'UPDATE_ASSET_TRACKING' || action === 'updateAssetTracking') {
          return window.PEMS.api.updateAssetTracking(payload);
        } else if (action === 'DELETE_INVENTORY_RECORD' || action === 'deleteInventoryRecord') {
          return window.PEMS.api.deleteInventoryRecord(payload.propertyNo || payload.propNo);
        } else {
          return window.PEMS.api.invoke(action, sessionId, payload);
        }
      }

      throw new Error('PEMS.api is not available to execute mutation.');
    },

    /**
     * Refreshes queue statistics from IndexedDB.
     */
    async refreshQueueStats() {
      if (!window.PEMS_DB) return;
      try {
        const stats = await window.PEMS_DB.getSyncStats();
        this.state.pendingCount = stats.pending;
        this.state.syncingCount = stats.syncing;
        this.state.failedCount = stats.failed;
        this.notifyListeners();
        this.updateSyncBadge();
      } catch (e) {
        console.warn('[PEMS Sync] Could not refresh queue stats:', e);
      }
    },

    /**
     * Updates the sync status badge in the navbar / header.
     */
    updateSyncBadge() {
      const badge = document.getElementById('pemsSyncBadge');
      const textEl = document.getElementById('pemsSyncBadgeText');
      const iconEl = document.getElementById('pemsSyncBadgeIcon');
      const syncNowBtn = document.getElementById('btnSyncNow');

      if (!badge) return;

      const { isSyncing, isOnline, serverReachable, pendingCount, failedCount } = this.state;

      if (isSyncing) {
        badge.className = 'sync-status-badge badge-syncing';
        if (textEl) textEl.textContent = 'Syncing...';
        if (iconEl) iconEl.innerHTML = '<svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>';
        if (syncNowBtn) syncNowBtn.disabled = true;
      } else if (failedCount > 0) {
        badge.className = 'sync-status-badge badge-failed';
        if (textEl) textEl.textContent = `Sync Error (${failedCount})`;
        if (iconEl) iconEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
        if (syncNowBtn) syncNowBtn.disabled = false;
      } else if (pendingCount > 0) {
        badge.className = 'sync-status-badge badge-pending';
        if (textEl) textEl.textContent = `Pending (${pendingCount})`;
        if (iconEl) iconEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
        if (syncNowBtn) syncNowBtn.disabled = false;
      } else if (!isOnline) {
        badge.className = 'sync-status-badge badge-offline';
        if (textEl) textEl.textContent = 'Offline';
        if (iconEl) iconEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/><path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/><path d="M10.71 5.05A16 16 0 0 1 22.58 9"/><path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>';
        if (syncNowBtn) syncNowBtn.disabled = true;
      } else {
        badge.className = 'sync-status-badge badge-synced';
        if (textEl) textEl.textContent = 'Synced';
        if (iconEl) iconEl.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>';
        if (syncNowBtn) syncNowBtn.disabled = false;
      }
    },

    /**
     * Opens the Sync Queue modal/drawer showing pending/failed items and retry options.
     */
    async openSyncDrawer() {
      const modal = document.getElementById('syncQueueDrawerModal');
      if (!modal) return;

      const container = document.getElementById('syncQueueListContainer');
      const countEl = document.getElementById('syncDrawerCountBadge');

      if (container) {
        container.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-muted);"><span class="loading-spinner-inline"></span> Loading synchronization queue...</div>';
      }

      modal.style.display = 'flex';

      try {
        const mutations = await window.PEMS_DB.getAllMutations();
        if (countEl) countEl.textContent = `${mutations.length} item${mutations.length === 1 ? '' : 's'}`;

        if (!container) return;

        if (mutations.length === 0) {
          container.innerHTML = `
            <div style="padding: 3rem 1.5rem; text-align: center; color: var(--text-muted);">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2" style="margin-bottom: 1rem;"><circle cx="12" cy="12" r="10"/><path d="M9 12l2 2 4-4"/></svg>
              <h4 style="color: #f8fafc; font-size: 1.1rem; margin: 0 0 0.5rem;">All Changes Synchronized</h4>
              <p style="font-size: 0.85rem; margin: 0;">No pending offline creations, edits, or deletes in the sync queue.</p>
            </div>
          `;
          return;
        }

        let html = '<div class="sync-queue-items-list">';
        mutations.forEach(item => {
          const statusClass = item.status === 'failed' ? 'status-err' : (item.status === 'syncing' ? 'status-syncing' : 'status-pending');
          const statusLabel = item.status === 'failed' ? 'Failed' : (item.status === 'syncing' ? 'Syncing...' : 'Pending');
          const actionLabel = item.action.replace(/_/g, ' ');
          const propNo = (item.payload && (item.payload.propertyNo || item.payload.propNo)) || 'ASSET';
          const time = new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

          html += `
            <div class="sync-queue-card ${statusClass}">
              <div class="sync-card-header">
                <span class="sync-card-prop font-mono">${PEMS.users.escapeHtml(propNo)}</span>
                <span class="sync-card-status ${statusClass}">${statusLabel}</span>
              </div>
              <div class="sync-card-body font-mono text-xs">
                <div>Action: <strong>${PEMS.users.escapeHtml(actionLabel)}</strong></div>
                <div class="text-muted">Enqueued: ${time} (Retries: ${item.retries || 0})</div>
                ${item.lastError ? `<div class="sync-card-error font-mono text-xs">Error: ${PEMS.users.escapeHtml(item.lastError)}</div>` : ''}
              </div>
            </div>
          `;
        });
        html += '</div>';

        container.innerHTML = html;
      } catch (err) {
        if (container) {
          container.innerHTML = `<div style="padding: 2rem; color: #ef4444;">Failed to load sync queue: ${err.message}</div>`;
        }
      }
    },

    closeSyncDrawer() {
      const modal = document.getElementById('syncQueueDrawerModal');
      if (modal) modal.style.display = 'none';
    }
  };

  // Expose globally
  window.PEMS_SYNC = PEMS_SYNC;

})(typeof window !== 'undefined' ? window : this);
