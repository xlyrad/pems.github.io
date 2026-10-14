/**
 * ============================================================================
 * PEMS PWA — INSTALL CONTROLLER & CROSS-PLATFORM PROMPTS
 * File: js/pwa-install.js
 * ============================================================================
 * Handles Progressive Web App installation across all supported platforms:
 * - Desktop Chrome / Edge & Android Chrome (native beforeinstallprompt)
 * - iPhone & iPad Safari (custom Add to Home Screen step-by-step guidance)
 */

(function(window) {
  'use strict';

  let deferredPrompt = null;

  const PEMS_INSTALL = {
    isInstalled: false,
    isIos: false,
    isSafari: false,

    init() {
      // 1. Detect if already running in standalone display mode
      const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
      this.isInstalled = isStandalone;

      // 2. Detect iOS / iPadOS and Safari
      const ua = window.navigator.userAgent || '';
      this.isIos = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
      this.isSafari = /^((?!chrome|android).)*safari/i.test(ua);

      // 3. Listen for Chrome/Edge/Android beforeinstallprompt
      window.addEventListener('beforeinstallprompt', (e) => {
        // Prevent default mini-infobar
        e.preventDefault();
        deferredPrompt = e;
        console.log('[PEMS Install] beforeinstallprompt captured.');
        this.showInstallButton();
      });

      // 4. Listen for app installed event
      window.addEventListener('appinstalled', () => {
        console.log('[PEMS Install] PEMS App installed successfully.');
        this.isInstalled = true;
        this.hideInstallButton();
        deferredPrompt = null;
        if (window.PEMS && window.PEMS.notification) {
          window.PEMS.notification.success('Installed', 'PEMS is now installed on your device. You can launch it anytime from your home screen or apps menu.');
        }
      });

      // 5. iOS Safari guidance
      if (this.isIos && !isStandalone) {
        // Show iOS install hint if not standalone
        this.setupIosInstallPrompt();
      }

      this.bindButtons();
    },

    bindButtons() {
      const installBtn = document.getElementById('btnPwaInstall');
      if (installBtn) {
        installBtn.addEventListener('click', () => this.promptInstall());
      }
    },

    showInstallButton() {
      const btn = document.getElementById('btnPwaInstall');
      if (btn) btn.style.display = 'inline-flex';
      const mobileBtn = document.getElementById('btnMobilePwaInstall');
      if (mobileBtn) mobileBtn.style.display = 'inline-flex';
    },

    hideInstallButton() {
      const btn = document.getElementById('btnPwaInstall');
      if (btn) btn.style.display = 'none';
      const mobileBtn = document.getElementById('btnMobilePwaInstall');
      if (mobileBtn) mobileBtn.style.display = 'none';
    },

    /**
     * Triggers the installation prompt.
     */
    async promptInstall() {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const choice = await deferredPrompt.userChoice;
        console.log('[PEMS Install] User choice:', choice.outcome);
        if (choice.outcome === 'accepted') {
          this.hideInstallButton();
        }
        deferredPrompt = null;
      } else if (this.isIos) {
        this.openIosInstallModal();
      } else {
        if (window.PEMS && window.PEMS.notification) {
          window.PEMS.notification.info(
            'Install PEMS',
            'To install on Chrome/Edge: Click the install icon (⊞) in your browser address bar.'
          );
        }
      }
    },

    setupIosInstallPrompt() {
      const btn = document.getElementById('btnPwaInstall');
      if (btn) btn.style.display = 'inline-flex';
      const mobileBtn = document.getElementById('btnMobilePwaInstall');
      if (mobileBtn) mobileBtn.style.display = 'inline-flex';
    },

    openIosInstallModal() {
      const modal = document.getElementById('iosInstallModal');
      if (modal) modal.style.display = 'flex';
    },

    closeIosInstallModal() {
      const modal = document.getElementById('iosInstallModal');
      if (modal) modal.style.display = 'none';
    }
  };

  window.PEMS_INSTALL = PEMS_INSTALL;

})(typeof window !== 'undefined' ? window : this);
