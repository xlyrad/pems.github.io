/**
 * ============================================================================
 * PEMS PWA — CLIENT CONFIGURATION & API ROUTER
 * File: pwa-config.js
 * ============================================================================
 * Centralized configuration for the standalone Progressive Web App.
 * Manages the Google Apps Script Web App API endpoint without hard-coding secrets.
 */

(function(window) {
  'use strict';

  const PEMS_CONFIG = {
    APP_NAME: 'PEMS',
    FULL_NAME: 'PROPERTY & EQUIPMENT MONITORING SYSTEM',
    VERSION: '1.0.0',
    BUILD_DATE: '2026-10-14',
    DEFAULT_STORAGE_ROOT_FOLDER: '161G4n840R4TZxEwQ5B7wFiSMytt7W8Fa',
    
    // Default API URL (Preset or configured via Settings modal)
    // Format: https://script.google.com/macros/s/[DEPLOYMENT_ID]/exec
    DEFAULT_API_URL: 'https://script.google.com/macros/s/AKfycbz0XutXKrzl712tVTIIbtLzSHyTSFbxI468d5BeoLJYZJgDdPQazI3zgg5IaYfPUXW7/exec',
    API_URL_STORAGE_KEY: 'pems_api_url',

    /**
     * Retrieves the currently active Google Apps Script Web API URL.
     * Looks in localStorage first, then fallback to default if configured.
     * @returns {string}
     */
    getApiUrl() {
      try {
        const stored = localStorage.getItem(this.API_URL_STORAGE_KEY);
        if (stored && stored.trim().startsWith('http')) {
          return stored.trim();
        }
      } catch (e) {}

      // Fallback 1: Preset DEFAULT_API_URL
      if (this.DEFAULT_API_URL && this.DEFAULT_API_URL.trim().startsWith('http')) {
        return this.DEFAULT_API_URL.trim();
      }

      // Fallback 2: check if window.PEMS_API_ENDPOINT was preset via HTML
      if (window.PEMS_API_ENDPOINT && typeof window.PEMS_API_ENDPOINT === 'string') {
        return window.PEMS_API_ENDPOINT.trim();
      }

      return '';
    },

    /**
     * Saves a new Google Apps Script Web API URL into persistent storage.
     * @param {string} url
     */
    setApiUrl(url) {
      const cleanUrl = String(url || '').trim();
      try {
        if (cleanUrl) {
          localStorage.setItem(this.API_URL_STORAGE_KEY, cleanUrl);
        } else {
          localStorage.removeItem(this.API_URL_STORAGE_KEY);
        }
      } catch (e) {}
      if (window.PEMS_SYNC && typeof window.PEMS_SYNC.triggerSync === 'function') {
        window.PEMS_SYNC.triggerSync('api_url_updated');
      }
    },

    /**
     * Tests connectivity to the specified or stored API endpoint.
     * @param {string} [testUrl]
     * @returns {Promise<Object>}
     */
    async testConnection(testUrl) {
      const url = testUrl ? String(testUrl).trim() : this.getApiUrl();
      if (!url) {
        return { success: false, message: 'No Google Apps Script Web API URL configured.' };
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 8000);

        const pingUrl = url + (url.indexOf('?') !== -1 ? '&' : '?') + 'action=ping&_t=' + Date.now();
        const res = await fetch(pingUrl, {
          method: 'GET',
          mode: 'cors',
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          const json = await res.json().catch(() => null);
          if (json && json.success) {
            return {
              success: true,
              message: `Connected successfully to PEMS API (${json.data ? json.data.version : 'Online'}).`,
              data: json.data
            };
          }
          return {
            success: false,
            message: (json && json.message) || 'Server returned an error response.'
          };
        }
        return {
          success: false,
          message: `HTTP Error: ${res.status} ${res.statusText}. Check deployment permissions (Must be set to "Anyone").`
        };
      } catch (err) {
        return {
          success: false,
          message: err.name === 'AbortError'
            ? 'Connection timed out after 8s. Check network connectivity and script permissions.'
            : `Network error: ${err.message}. Ensure Web App is deployed with access set to "Anyone".`
        };
      }
    }
  };

  window.PEMS_CONFIG = PEMS_CONFIG;

})(typeof window !== 'undefined' ? window : this);
