// ==UserScript==
// @name         CleanPage v40.1.1 — Unified Protector (Merged & Patched)
// @namespace    https://example.local/cleanpage
// @version      40.1.1
// @description  v40.1.1: Merged Build. Contains v40.1 features (Full UI, Lists) + v40.1.1 patches (Syntax, Stealth, Logic fixes).
// @author       You (Merged & Enhanced)
// @match        *://*/*
// @exclude      chrome-extension://*
// @exclude      moz-extension://*
// @exclude      about:blank
// @exclude      file:///*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @run-at       document-start
// ==/UserScript==

/*
  CleanPage v40.1.1 (Merged)
  - This script merges the full feature set of v40.1.0 with the
    critical fixes from the v40.1.1 patch.
  - FEATURES:
    - Full v40.1.0 SafeView UI with all tabs (Lists, Stats, Backup, etc.).
    - External "lite" blocklist fetcher and cache.
    - Element Zapper, Privacy modules, and all interceptors.
  - FIXES (from v40.1.1):
    - Patched 'use strict' syntax error.
    - Patched checkBlockList to correctly handle parent/subdomain relief.
    - Patched matchesAny() to gracefully handle invalid selectors.
    - Patched scanForShadowRoots() with a depth guard to prevent recursion crashes.
    - Patched applyScriptlet() to safely escape RegExp strings.
    - Patched fetch/XHR/window.open wrappers for better stealth and error handling.
    - Patched popupBlocker to allow benign 'about:blank'.
    - Patched blockElement for stealthier removal (using requestIdleCallback).
    - Added debounced state saving (scheduleSaveState) for performance.
*/

(function () {
  'use strict';

  /*************** Metadata / Safe token *****************/
  const SCRIPT_NAME = 'CleanPage';
  const VERSION = '40.1.1'; // UNIFIED + LITE LISTS (Patched)
  const CP_TOKEN = 'cp-v40_1-'; // New token for clean settings
  const DOMAIN = window.location.hostname;
  const DEBUG_API_ID = '__cpDebugAPI_v40_1';
  const LOG_LIMIT = 500;

  /*************** Configuration Management ***************/

  // --- v37.1 Default Lists ---
  const DEFAULT_TRACKERS = [
      {"pattern":"doubleclick.net","category":"ads","comment":"DoubleClick/Google Ads"},
      {"pattern":"googlesyndication","category":"ads","comment":"Google Syndication"},
      {"pattern":"google-analytics.com","category":"analytics","comment":"Google Analytics"},
      {"pattern":"googletagmanager","category":"analytics","comment":"Google Tag Manager"},
      {"pattern":"adroll.com","category":"ads","comment":"AdRoll"},
      {"pattern":"criteo.com","category":"ads","comment":"Criteo"},
      {"pattern":"facebook.net","category":"social","comment":"Facebook social pixels"},
      {"pattern":"scorecardresearch.com","category":"analytics","comment":"Scorecard Research"},
      {"pattern":"quantserve.com","category":"analytics","comment":"Quantserve"},
      {"pattern":"mixpanel.com","category":"analytics","comment":"Mixpanel"},
      {"pattern":"hotjar.com","category":"analytics","comment":"Hotjar"},
      {"pattern":"moatads.com","category":"measurement","comment":"Moat measurement"},
  ];

  const DEFAULT_HEURISTICS = [
      { selector: '[style*="position: fixed"][style*="z-index: 99999"]', scope: 'always', comment: 'High z-index fixed overlay' },
      { selector: '[style*="position: fixed"][style*="z-index: 9999"]', scope: 'always', comment: 'High z-index fixed overlay' },
      { selector: 'div[id*="cookie-consent-banner"]', scope: 'always', comment: 'Cookie consent' },
      { selector: 'div[class*="cookie"]', scope: 'always', comment: 'Cookie consent' },
      { selector: 'div[class*="consent"]', scope: 'always', comment: 'Consent elements' },
      { selector: 'div[class*="popup-backdrop"]', scope: 'aggressive', comment: 'Popup backdrop' },
      { selector: 'div[class*="anti-adblock"]', scope: 'aggressive', comment: 'Anti-adblock' },
      { selector: 'div[class*="modal-overlay"]', scope: 'aggressive', comment: 'Modal overlay' },
  ];

  // --- v39.0 Default Scriptlets ---
  const DEFAULT_SCRIPTLETS = [
      {"pattern": "gpt.js", "find": "window.googletag", "replace": "window.googletag_disabled", "comment": "Disable Google Publisher Tags (Example)"},
      {"pattern": "analytics.js", "find": "window.ga=", "replace": "window.ga_disabled=", "comment": "Disable Google Analytics (Example)"}
  ];

  // --- v36.5 Learning Patterns ---
  const LEARNING_PATTERNS = [
      'ad', 'overlay', 'popup', 'modal', 'sponsor', 'tracking', 'cookie', 'consent', 'banner', 'block'
  ];

  let config = {
    enabled: true,
    safeViewOpen: false,
    blockingMode: 'Aggressive',
    useFetchInterceptor: true,
    useXHRInterceptor: true,
    useIframeBlocker: true,
    useMutationObserver: true,
    usePopupBlocker: true,
    useStorageIsolation: false, // Opt-in
    muteLogs: false,
    showBarStats: true,
    // v39 Privacy Features (Opt-in)
    useShadowDOMScanner: true, // Default on
    useAntiFingerprinting: false,
    useWebRTCLeakProtection: false,
    useScriptletInjection: false,
    // v40.1 External List (Opt-in)
    useExternalBlocklists: true,
    externalBlocklistURLs: [
        'https://raw.githubusercontent.com/StevenBlack/hosts/master/lists/hosts.txt'
    ],
    externalListUpdateInterval: 86400000, // 24 hours
    // v36 Lists
    allowList: new Set(['example.com', 'localhost']),
    userBlockList: new Set(['bad-iframe.com', 'tracking.net']), // Renamed from blockList
    reliefList: [],
    learnedSelectorList: new Set(),
    // v37/v39 Lists
    customTrackers: DEFAULT_TRACKERS,
    heuristics: DEFAULT_HEURISTICS,
    scriptlets: DEFAULT_SCRIPTLETS, // v39
  };

  // Internal Map for quick O(1) relief lookup: Domain -> { expiry: number | null, reason: string }
  let reliefDomains = new Map();

  // v40.1: Cached list for fetched domains
  let fetchedBlockList = new Set();
  let lastListUpdate = 0;

  let stats = {
    blockedIframes: 0,
    blockedFetches: 0, // Now includes XHR
    blockedMutations: 0,
    popupBlocked: 0,
    blockedTotal: 0,
    sessionStart: Date.now(),
  };

  let filterLogs = [];
  let logs = [];
  let isPaused = false;
  let shadowObserverList = []; // Store observers for shadow roots
  let isZapperActive = false; // v40
  let zapperToast = null; // v40

  /*************** Core Utility Functions (Patched) ***************/

  /**
   * Generates a dynamic, randomized delay for blocking actions.
   * (v40.1.1: Wider randomization)
   */
  const stealthDelay = () => Math.floor(Math.random() * 150) + 20;

  /**
   * (v40) Escapes a string for use in CSS selectors.
   */
  function cssEscape(s) {
      if (window.CSS && CSS.escape) return CSS.escape(s);
      return String(s).replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
  }

  /**
   * (v40.1.1) Escapes a string for use in a RegExp literal.
   */
  function escapeRegExp(s) {
      return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * (v40.1.1) Robustly checks if an element matches any selector in an array.
   * Gracefully skips individual invalid selectors.
   */
  function matchesAny(el, selectorsArr) {
    if (!el || typeof el.matches !== 'function') return false;
    if (!Array.isArray(selectorsArr)) return false;
    for (let i = 0; i < selectorsArr.length; i++) {
        const s = selectorsArr[i];
        if (!s) continue;
        try {
            if (el.matches(s)) return true;
        } catch (err) {
            // invalid selector, skip
            continue;
        }
    }
    return false;
  }

  /**
   * Logs a debug message, respecting the muteLogs setting.
   */
  function logDebug(msg, type = 'info') {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const logEntry = `${time} [${type.toUpperCase()}] ${msg}`;

    logs.push(logEntry);
    if (logs.length > LOG_LIMIT) logs.shift(); // Maintain log limit

    if (!config.muteLogs || type === 'error' || type === 'warn') {
        const consoleFunc = console[type] || console.log;
        try { consoleFunc(`[${SCRIPT_NAME}] ${msg}`); } catch (e) {}
    }
  }

  /**
   * Logs a filter action (block or allow).
   */
  function logFilter(type, target, reason) {
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const entry = { time, type, target, reason };
    filterLogs.push(entry);
    if (filterLogs.length > LOG_LIMIT) filterLogs.shift();
  }

  /**
   * (v40.1.1) Debounced saveState to avoid frequent storage writes.
   */
  let _saveTimeout = null;
  function scheduleSaveState(delay = 2000) {
    if (_saveTimeout) clearTimeout(_saveTimeout);
    _saveTimeout = setTimeout(() => {
      saveState();
      _saveTimeout = null;
    }, delay);
  }

  /**
   * (v40.1.1) Handles user interaction for confirmation before destructive actions.
   * More robust: appends to documentElement and has a native confirm() fallback.
   */
  function promptConfirmation(message) {
      return new Promise((resolve) => {
          try {
              const confirmationModal = document.createElement('div');
              confirmationModal.id = 'cp-confirmation-modal';
              confirmationModal.className = 'cp-modal';
              confirmationModal.style.cssText = `
                  display: flex; position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                  background-color: rgba(0,0,0,0.7); z-index: 100000; justify-content: center; align-items: center;
              `;
              confirmationModal.innerHTML = `
                  <div style="background: #2b2e31; padding: 20px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,0,0,0.5); width: 90%; max-width: 400px; color: #f0f0f0;">
                      <p style="margin-bottom: 20px; font-weight: 600;">${message}</p>
                      <div style="display: flex; justify-content: space-around;">
                          <button id="cp-confirm-yes" class="cp-button cp-button-red" style="padding: 10px 20px;">Yes</button>
                          <button id="cp-confirm-no" class="cp-button cp-button-green" style="padding: 10px 20px;">No</button>
                      </div>
                  </div>
              `;
              document.documentElement.appendChild(confirmationModal);
              const cleanup = () => {
                  const modal = document.getElementById('cp-confirmation-modal');
                  if (modal && modal.parentElement) {
                      modal.parentElement.removeChild(modal);
                  }
              };
              document.getElementById('cp-confirm-yes').onclick = () => { cleanup(); resolve(true); };
              document.getElementById('cp-confirm-no').onclick = () => { cleanup(); resolve(false); };
          } catch (e) {
              // Fallback to native confirm in very constrained environments
              try { resolve(confirm(message)); } catch (err) { resolve(false); }
          }
      });
  }

  /*************** Storage & Persistence (v40.1) ***************/

  /**
   * Saves configuration to GreaseMonkey storage.
   */
  function saveConfig() {
    try {
      const reliefListForStorage = Array.from(reliefDomains.entries()).map(([domain, data]) => ({
          domain,
          expiry: data.expiry,
          reason: data.reason || 'Persistent Relief'
      }));

      const configToStore = {
          enabled: config.enabled,
          safeViewOpen: config.safeViewOpen,
          blockingMode: config.blockingMode,
          useFetchInterceptor: config.useFetchInterceptor,
          useXHRInterceptor: config.useXHRInterceptor,
          useIframeBlocker: config.useIframeBlocker,
          useMutationObserver: config.useMutationObserver,
          usePopupBlocker: config.usePopupBlocker,
          useStorageIsolation: config.useStorageIsolation,
          muteLogs: config.muteLogs,
          showBarStats: config.showBarStats,
          // v39
          useShadowDOMScanner: config.useShadowDOMScanner,
          useAntiFingerprinting: config.useAntiFingerprinting,
          useWebRTCLeakProtection: config.useWebRTCLeakProtection,
          useScriptletInjection: config.useScriptletInjection,
          // v40.1
          useExternalBlocklists: config.useExternalBlocklists,
          externalBlocklistURLs: config.externalBlocklistURLs,
          externalListUpdateInterval: config.externalListUpdateInterval,
          // Lists
          allowList: Array.from(config.allowList),
          userBlockList: Array.from(config.userBlockList), // Renamed
          reliefList: reliefListForStorage,
          learnedSelectorList: Array.from(config.learnedSelectorList),
          customTrackers: config.customTrackers,
          heuristics: config.heuristics,
          scriptlets: config.scriptlets,
      };
      GM_setValue(CP_TOKEN + 'config', JSON.stringify(configToStore));
      logDebug('Configuration saved.');
    } catch (e) {
      logDebug(`Error saving config: ${e.message}`, 'error');
    }
  }

  /**
   * Saves state data (stats, logs) to GreaseMonkey storage.
   */
  function saveState() {
    try {
      GM_setValue(CP_TOKEN + 'stats', JSON.stringify(stats));
      GM_setValue(CP_TOKEN + 'filterLogs', JSON.stringify(filterLogs));
      GM_setValue(CP_TOKEN + 'logs', JSON.stringify(logs));
      // Note: Fetched list is saved by updateExternalBlocklists()
      logDebug('State saved.');
    } catch (e) {
      logDebug(`Error saving state: ${e.message}`, 'error');
    }
  }

  /**
   * Loads configuration from GreaseMonkey storage.
   */
  function loadConfig() {
    try {
      const storedConfig = GM_getValue(CP_TOKEN + 'config');
      if (storedConfig) {
        logDebug('Configuration found in storage. Attempting to load...');
        const loadedConfig = JSON.parse(storedConfig);

        // --- 1. Explicitly load primitive settings ---
        const keysToLoad = [
            'enabled', 'safeViewOpen', 'blockingMode', 'useFetchInterceptor', 'useXHRInterceptor',
            'useIframeBlocker', 'useMutationObserver', 'usePopupBlocker', 'useStorageIsolation',
            'muteLogs', 'showBarStats', 'useShadowDOMScanner', 'useAntiFingerprinting',
            'useWebRTCLeakProtection', 'useScriptletInjection', 'useExternalBlocklists',
            'externalListUpdateInterval'
        ];
        keysToLoad.forEach(key => {
            if (loadedConfig[key] !== undefined) {
                config[key] = loadedConfig[key];
            }
        });

        // --- 2. Convert and load Set-based lists (v36) ---
        config.allowList = new Set(loadedConfig.allowList || []);
        config.userBlockList = new Set(loadedConfig.userBlockList || loadedConfig.blockList || []); // Handle old name "blockList"
        config.learnedSelectorList = new Set(loadedConfig.learnedSelectorList || []);

        // --- 3. Load Array-based lists (v37/v39/v40) ---
        config.customTrackers = Array.isArray(loadedConfig.customTrackers) ? loadedConfig.customTrackers : DEFAULT_TRACKERS;
        config.heuristics = Array.isArray(loadedConfig.heuristics) ? loadedConfig.heuristics : DEFAULT_HEURISTICS;
        config.scriptlets = Array.isArray(loadedConfig.scriptlets) ? loadedConfig.scriptlets : DEFAULT_SCRIPTLETS;
        config.externalBlocklistURLs = Array.isArray(loadedConfig.externalBlocklistURLs) ? loadedConfig.externalBlocklistURLs : config.externalBlocklistURLs;

        // --- 4. Handle relief list conversion (v36.5.5 fix) ---
        reliefDomains = new Map();
        let reliefChanged = false;
        if (Array.isArray(loadedConfig.reliefList)) {
            const now = Date.now();
            loadedConfig.reliefList.forEach(item => {
                if (item && item.domain) {
                    if (item.expiry === null || item.expiry === undefined || item.expiry > now) {
                        reliefDomains.set(item.domain, { expiry: item.expiry, reason: item.reason || 'Persistent Relief' });
                    } else {
                        reliefChanged = true;
                    }
                }
            });
        }
        if (reliefChanged) saveConfig();

        logDebug(`Configuration loaded. ${reliefDomains.size} active relief domain(s).`);
      } else {
         logDebug('No configuration found in storage. Using default settings.', 'info');
         saveConfig(); // Save defaults on first run
      }
    } catch (e) {
      logDebug(`Error loading or parsing config, using defaults: ${e.message}`, 'error');
    }
  }

  /**
   * Loads state data (stats, logs, fetched lists) from GreaseMonkey storage.
   */
  function loadFetchedData() {
    try {
      const storedStats = GM_getValue(CP_TOKEN + 'stats');
      if (storedStats) stats = { ...stats, ...JSON.parse(storedStats) };
      const storedFilterLogs = GM_getValue(CP_TOKEN + 'filterLogs');
      if (storedFilterLogs) filterLogs = JSON.parse(storedFilterLogs);
      const storedLogs = GM_getValue(CP_TOKEN + 'logs');
      if (storedLogs) logs = JSON.parse(storedLogs);
      
      // v40.1: Load fetched list cache
      const storedList = GM_getValue(CP_TOKEN + 'fetched_list');
      if (storedList) fetchedBlockList = new Set(JSON.parse(storedList));
      lastListUpdate = GM_getValue(CP_TOKEN + 'last_list_update', 0);
      logDebug(`State loaded. ${fetchedBlockList.size} domains in external list cache.`);
    } catch (e) {
      logDebug(`Error loading or parsing state, resetting: ${e.message}`, 'error');
    }
  }

  /**
   * Resets all logs.
   */
  async function resetLogs() {
    const confirmed = await promptConfirmation('Are you sure you want to flush ALL filter and debug logs?');
    if (confirmed) {
      filterLogs = []; logs = []; saveState();
      logDebug('All logs have been flushed.');
      updateSafeViewUI();
    }
  }

  /**
   * Resets all statistics.
   */
  async function resetStats() {
    const confirmed = await promptConfirmation('Are you sure you want to reset ALL blocking statistics?');
    if (confirmed) {
      stats = { blockedIframes: 0, blockedFetches: 0, blockedMutations: 0, popupBlocked: 0, blockedTotal: 0, sessionStart: Date.now() };
      saveState();
      logDebug('All statistics have been reset.');
      updateSafeViewUI();
    }
  }

  /*************** Backups & Import/Export (v40.1) ***************/

  /**
   * Creates a new backup of the current config and state.
   */
  function createBackup() {
    try {
      const backups = JSON.parse(GM_getValue(CP_TOKEN + 'backups', '[]'));
      const timestamp = new Date().toISOString();
      const reliefListForStorage = Array.from(reliefDomains.entries()).map(([domain, data]) => ({
          domain, expiry: data.expiry, reason: data.reason
      }));

      const configToBackup = { ...config };
      configToBackup.allowList = Array.from(config.allowList);
      configToBackup.userBlockList = Array.from(config.userBlockList);
      configToBackup.learnedSelectorList = Array.from(config.learnedSelectorList);
      configToBackup.reliefList = reliefListForStorage;

      const backupData = {
        timestamp,
        version: VERSION,
        config: JSON.stringify(configToBackup),
        stats: JSON.stringify(stats),
        filterLogs: JSON.stringify(filterLogs),
        // Note: We don't back up the fetched list, it will be re-fetched.
      };
      backups.unshift(backupData);
      if (backups.length > 10) backups.pop();
      GM_setValue(CP_TOKEN + 'backups', JSON.stringify(backups));
      logDebug(`Backup created successfully: ${timestamp}`);
      if (config.safeViewOpen) updateSafeViewUI();
      return true;
    } catch (e) {
      logDebug(`Error creating backup: ${e.message}`, 'error');
      return false;
    }
  }

  /**
   * Restores config and state from a backup.
   */
  function restoreFromBackup(backupData) {
    try {
      const restoredConfig = JSON.parse(backupData.config);
      const keysToRestore = [
          'enabled', 'safeViewOpen', 'blockingMode', 'useFetchInterceptor', 'useXHRInterceptor',
          'useIframeBlocker', 'useMutationObserver', 'usePopupBlocker', 'useStorageIsolation',
          'muteLogs', 'showBarStats', 'useShadowDOMScanner', 'useAntiFingerprinting',
          'useWebRTCLeakProtection', 'useScriptletInjection', 'useExternalBlocklists',
          'externalListUpdateInterval'
      ];
      keysToRestore.forEach(key => {
          config[key] = restoredConfig[key] !== undefined ? restoredConfig[key] : config[key];
      });

      // Restore lists
      config.allowList = new Set(restoredConfig.allowList || []);
      config.userBlockList = new Set(restoredConfig.userBlockList || restoredConfig.blockList || []); // Handle old name
      config.learnedSelectorList = new Set(restoredConfig.learnedSelectorList || []);
      config.customTrackers = Array.isArray(restoredConfig.customTrackers) ? restoredConfig.customTrackers : DEFAULT_TRACKERS;
      config.heuristics = Array.isArray(restoredConfig.heuristics) ? restoredConfig.heuristics : DEFAULT_HEURISTICS;
      config.scriptlets = Array.isArray(restoredConfig.scriptlets) ? restoredConfig.scriptlets : DEFAULT_SCRIPTLETS;
      config.externalBlocklistURLs = Array.isArray(restoredConfig.externalBlocklistURLs) ? restoredConfig.externalBlocklistURLs : config.externalBlocklistURLs;

      reliefDomains = new Map();
      if (Array.isArray(restoredConfig.reliefList)) {
           restoredConfig.reliefList.forEach(item => {
               if (item && item.domain) {
                   reliefDomains.set(item.domain, { expiry: item.expiry, reason: item.reason || 'Persistent Relief' });
               }
           });
      }
      saveConfig();

      // Restore State
      stats = JSON.parse(backupData.stats);
      filterLogs = JSON.parse(backupData.filterLogs);
      saveState();

      logDebug(`Successfully restored from backup: ${backupData.timestamp}. Reloading...`);
      updateSafeViewUI();
      setTimeout(() => window.location.reload(), 100);
      return true;
    } catch (e) {
      logDebug(`Error restoring backup: ${e.message}`, 'error');
      return false;
    }
  }

  /**
   * Export the full configuration and state as a JSON string.
   */
  function exportData() {
    const reliefListForStorage = Array.from(reliefDomains.entries()).map(([domain, data]) => ({
        domain, expiry: data.expiry, reason: data.reason
    }));
    
    const configToExport = {
        ...config,
        allowList: Array.from(config.allowList),
        userBlockList: Array.from(config.userBlockList),
        learnedSelectorList: Array.from(config.learnedSelectorList),
        reliefList: reliefListForStorage
    };

    const exportObject = {
      _metadata: { version: VERSION, timestamp: new Date().toISOString() },
      config: configToExport,
      stats: stats,
      filterLogs: filterLogs,
    };
    
    const jsonString = JSON.stringify(exportObject, null, 2);
    const el = document.createElement('textarea');
    el.value = jsonString;
    el.setAttribute('readonly', '');
    el.style.position = 'absolute';
    el.style.left = '-9999px';
    document.documentElement.appendChild(el);
    el.select();
    try {
      document.execCommand('copy');
      logDebug('Configuration and State copied to clipboard successfully!');
    } catch (err) {
      logDebug('Could not copy data to clipboard.', 'error');
    }
    document.documentElement.removeChild(el);
  }

  /**
   * Imports configuration and state from a JSON string.
   */
  function importData(jsonString) {
    try {
      const importedObject = JSON.parse(jsonString);
      const importedConfig = importedObject.config;
      if (!importedConfig || !importedObject._metadata) {
        throw new Error('Invalid or corrupted import format.');
      }
      
      const keysToRestore = [
          'enabled', 'safeViewOpen', 'blockingMode', 'useFetchInterceptor', 'useXHRInterceptor',
          'useIframeBlocker', 'useMutationObserver', 'usePopupBlocker', 'useStorageIsolation',
          'muteLogs', 'showBarStats', 'useShadowDOMScanner', 'useAntiFingerprinting',
          'useWebRTCLeakProtection', 'useScriptletInjection', 'useExternalBlocklists',
          'externalListUpdateInterval'
      ];
      keysToRestore.forEach(key => {
          config[key] = importedConfig[key] !== undefined ? importedConfig[key] : config[key];
      });

      config.allowList = new Set(importedConfig.allowList || []);
      config.userBlockList = new Set(importedConfig.userBlockList || importedConfig.blockList || []); // Handle old name
      config.learnedSelectorList = new Set(importedConfig.learnedSelectorList || []); 
      config.customTrackers = Array.isArray(importedConfig.customTrackers) ? importedConfig.customTrackers : DEFAULT_TRACKERS;
      config.heuristics = Array.isArray(importedConfig.heuristics) ? importedConfig.heuristics : DEFAULT_HEURISTICS;
      config.scriptlets = Array.isArray(importedConfig.scriptlets) ? importedConfig.scriptlets : DEFAULT_SCRIPTLETS;
      config.externalBlocklistURLs = Array.isArray(importedConfig.externalBlocklistURLs) ? importedConfig.externalBlocklistURLs : config.externalBlocklistURLs;

      reliefDomains = new Map();
      if (Array.isArray(importedConfig.reliefList)) {
           importedConfig.reliefList.forEach(item => {
               if (item && item.domain) {
                   reliefDomains.set(item.domain, { expiry: item.expiry, reason: item.reason || 'Persistent Relief' });
               }
           });
      }
      saveConfig();

      if (importedObject.stats) stats = { ...stats, ...importedObject.stats };
      if (importedObject.filterLogs) filterLogs = importedObject.filterLogs;
      saveState();

      logDebug(`Successfully imported data from version ${importedObject._metadata.version}. Reloading...`);
      setTimeout(() => window.location.reload(), 100);
      return true;
    } catch (e) {
      logDebug(`Import failed: ${e.message}`, 'error');
      return false;
    }
  }

  /**
   * (v40.1.1) Prompts the user to paste JSON data for import.
   * More robust: attaches to documentElement.
   */
  async function promptImportData() {
      try {
          if (document.getElementById('cp-safeview-modal')?.style.display === 'flex') {
              hideSafeView();
          }
      } catch (e) {}
      const confirmed = await promptConfirmation('The import process will OVERWRITE your current settings, statistics, and lists. Proceed?');
      if (!confirmed) {
          logDebug('Import cancelled by user confirmation.');
          return;
      }
      try {
          const importModal = document.createElement('div');
          importModal.id = 'cp-import-prompt-modal';
          importModal.className = 'cp-modal';
          importModal.innerHTML = `
              <div class="cp-modal-content" style="max-width: 600px; padding: 25px;">
                  <h3 style="margin-top: 0; color: var(--cp-text-light);">Import CleanPage Data</h3>
                  <p style="margin-bottom: 15px;">Paste the exported JSON string below and click Import. The page will reload after a successful import.</p>
                  <textarea id="cp-import-prompt-textarea" class="cp-list-textarea" style="height: 200px;" placeholder="Paste JSON data here..."></textarea>
                  <div style="display: flex; justify-content: space-between; margin-top: 20px;">
                      <button id="cp-import-prompt-cancel" class="cp-button cp-button-red">Cancel</button>
                      <button id="cp-import-prompt-execute" class="cp-button cp-button-blue">Import & Reload</button>
                  </div>
              </div>
          `;
          document.documentElement.appendChild(importModal);
          const cleanup = () => {
              const modal = document.getElementById('cp-import-prompt-modal');
              if (modal && modal.parentElement) modal.parentElement.removeChild(modal);
          };
          document.getElementById('cp-import-prompt-cancel').onclick = cleanup;
          document.getElementById('cp-import-prompt-execute').onclick = () => {
              const jsonString = document.getElementById('cp-import-prompt-textarea').value.trim();
              cleanup();
              if (jsonString) importData(jsonString);
              else logDebug('Import cancelled: No data entered.', 'warn');
          };
      } catch (e) {
          logDebug(`Import UI failed: ${e.message}`, 'error');
      }
  }

  /*************** External List Fetcher (v40.1) ***************/

  /**
   * (v40.1) Fetches a URL using GM_xmlhttpRequest.
   */
  function fetchWithGM(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: url,
        responseType: 'text',
        onload: (response) => {
          if (response.status >= 200 && response.status < 300) {
            resolve(response.responseText);
          } else {
            reject(new Error(`HTTP Error: ${response.status}`));
          }
        },
        onerror: (error) => reject(new Error('Network Error')),
        ontimeout: () => reject(new Error('Timeout')),
      });
    });
  }

  /**
   * (v40.1.1) Parses a plain text hosts file into an array of domains.
   * Handles formats: `0.0.0.0 example.com`, `127.0.0.1 example.com`, and `example.com`
   * Patched: Converts to lowercase.
   */
  function parseHostsFile(text) {
    return text.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#')) // Remove comments and empty lines
      .map(line => {
        const parts = line.split(/\s+/); // Split by whitespace
        if (parts.length > 1 && (parts[0] === '0.0.0.0' || parts[0] === '127.0.0.1')) {
          return parts[1].replace(/^\.*/, '').toLowerCase(); // Return the domain from '0.0.0.0 example.com'
        }
        if (parts.length === 1 && parts[0].includes('.')) {
          return parts[0].replace(/^\.*/, '').toLowerCase(); // Return the domain if it's 'example.com'
        }
        return null;
      })
      .filter(Boolean); // Filter out nulls/invalid lines
  }

  /**
   * (v40.1) Fetches and updates all external blocklists.
   */
  async function updateExternalBlocklists(force = false) {
    if (!config.useExternalBlocklists && !force) return;

    const now = Date.now();
    if (!force && (now - lastListUpdate < config.externalListUpdateInterval)) {
      logDebug('External list update skipped (cache fresh).');
      return;
    }

    logDebug('Starting external blocklist update...');
    let allNewDomains = new Set();
    for (const url of config.externalBlocklistURLs) {
      try {
        const text = await fetchWithGM(url);
        const domains = parseHostsFile(text);
        domains.forEach(d => allNewDomains.add(d));
        logDebug(`Fetched ${domains.length} domains from ${url}`);
      } catch (error) {
        logDebug(`Failed to fetch list ${url}: ${error.message}`, 'error');
      }
    }

    if (allNewDomains.size > 0) {
      fetchedBlockList = allNewDomains;
      GM_setValue(CP_TOKEN + 'fetched_list', JSON.stringify(Array.from(fetchedBlockList)));
      lastListUpdate = now;
      GM_setValue(CP_TOKEN + 'last_list_update', lastListUpdate);
      logDebug(`External blocklist cache updated with ${fetchedBlockList.size} total unique domains.`);
    } else if (force) {
      logDebug('Forced update failed to fetch any new domains.', 'warn');
    }
    
    // Update UI if it's open
    if (config.safeViewOpen) updateSafeViewUI();
  }


  /*************** Blocking Core Logic (Patched) ***************/

  /**
   * Smart tracker matching function.
   * (v40.1.1: Added safety checks)
   */
  function hostMatchesTracker(hostOrUrl) {
    try {
      let text = (hostOrUrl || '').toLowerCase();
      let hostname = '';
      try { hostname = new URL(hostOrUrl, location.href).hostname.toLowerCase(); } catch (e) {}
      text = hostname || text;
      
      for (const t of (config.customTrackers || [])) {
        if (!t || !t.pattern) continue;
        const pattern = t.pattern.toLowerCase();
        if (hostname && (hostname === pattern || hostname.endsWith('.' + pattern))) return t;
        if ((hostOrUrl || '').toLowerCase().indexOf(pattern) !== -1) return t;
      }
    } catch (e) {}
    return null;
  }

  /**
   * (v40.1.1) Helper to get a domain and its parent domains.
   * (e.g., "ads.foo.com" -> ["ads.foo.com", "foo.com", "com"])
   */
  function domainAndParents(hostname) {
    if (!hostname) return [];
    const parts = hostname.split('.').filter(Boolean);
    const res = [];
    for (let i = 0; i <= parts.length - 1; i++) {
      res.push(parts.slice(i).join('.'));
    }
    return res;
  }


  /**
   * (v40.1.1) Unified block checker (Relief, Allow, Trackers, User List, Fetched List).
   * Patched: Correctly checks parent domains for Relief and Allow lists.
   */
  function checkBlockList(targetUrl) {
    let domain;
    try {
        domain = new URL(targetUrl, location.href).hostname;
    } catch (e) {
        domain = String(targetUrl || '').trim(); // Fallback
    }
    if (!domain) return null;
    const domainLower = domain.toLowerCase();

    // 1. Relief Check - consider parent domains
    for (const candidate of domainAndParents(domainLower)) {
      const relief = reliefDomains.get(candidate);
      if (relief) {
        if (relief.expiry === null || Date.now() < relief.expiry) {
            return null; // Allowed: Active relief
        } else {
            reliefDomains.delete(candidate);
            saveConfig();
            logDebug(`Session Relief expired for ${candidate}.`, 'warn');
        }
      }
    }

    // 2. AllowList Check - consider parent domains
    for (const candidate of domainAndParents(domainLower)) {
      if (config.allowList.has(candidate)) return null;
    }

    // 3. Custom Tracker Check (Pattern-based)
    const trackerMatch = hostMatchesTracker(targetUrl); 
    if (trackerMatch) {
        return `Tracker Match: ${trackerMatch.pattern}`;
    }

    // 4. User BlockList Check (Domain or parent domain)
    for (const blockedDomain of config.userBlockList) {
      const bd = String(blockedDomain).toLowerCase();
      if (domainLower === bd || domainLower.endsWith('.' + bd)) {
        return `Subdomain of BlockList Match: ${bd} (User)`;
      }
    }
    if (config.userBlockList.has(domainLower)) return 'Domain BlockList Match (User)'; // Exact match

    // 5. External BlockList Check (Domain-based)
    if (config.useExternalBlocklists && fetchedBlockList.has(domainLower)) {
        return 'Domain BlockList Match (External)';
    }
    
    return null; // No match, allow
  }

  /**
   * LEARNING ENGINE CORE: Analyzes a blocked element and extracts patterns.
   * (v40.1.1: Added safety checks)
   */
  function learnFromBlockedElement(element, originalReason) {
    try {
      if (!originalReason || !originalReason.includes('Selector Match')) return;
      let learnedSomething = false;

      if (element.id) {
          LEARNING_PATTERNS.forEach(pattern => {
              if (element.id.toLowerCase().includes(pattern)) {
                  const fullSelector = `#${element.id}`;
                  if (!config.learnedSelectorList.has(fullSelector)) {
                      config.learnedSelectorList.add(fullSelector);
                      learnedSomething = true;
                  }
              }
          });
      }

      if (element.className && typeof element.className === 'string') {
          const classes = element.className.split(/\s+/).filter(c => c.length > 0);
          classes.forEach(className => {
              LEARNING_PATTERNS.forEach(pattern => {
                  if (className.toLowerCase().includes(pattern) && className.length > 5) {
                      const partialSelector = `[class*="${className}"]`;
                      if (!config.learnedSelectorList.has(partialSelector)) {
                          config.learnedSelectorList.add(partialSelector);
                          learnedSomething = true;
                      }
                  }
              });
          });
      }
      
      if (learnedSomething) {
          logDebug(`Learned new selectors.`);
          saveConfig(); // Save immediately
      }
    } catch (e) {
        logDebug(`learnFromBlockedElement error: ${e.message}`, 'warn');
    }
  }

  /**
   * (v40.1.1) Stealthily removes an element and updates stats.
   * Patched: Uses requestIdleCallback and wider delay for better stealth.
   */
  function blockElement(element, reason, type) {
    try {
      if (!element || element.nodeType !== 1 || element.hasAttribute('data-cp-removed')) {
        return;
      }
      if (type === 'mutation') {
        learnFromBlockedElement(element, reason);
      }
      element.setAttribute('data-cp-removed', 'true'); // Mark immediately

      // stealthy removal: fade and remove on idle or after random delay
      const safeRemove = () => {
        try {
          if (element.parentElement) {
            element.remove();
            const target = element.tagName.toLowerCase() + (element.id ? `#${element.id}` : '') + (element.className ? `.${element.className.split(' ')[0]}` : '');
            logFilter('BLOCKED', target, reason);

            stats.blockedTotal++;
            if (type === 'iframe') stats.blockedIframes++;
            if (type === 'mutation') stats.blockedMutations++;

            if (config.safeViewOpen) updateSafeViewUI();
            scheduleSaveState();
          }
        } catch (e) { logDebug(`blockElement remove error: ${e.message}`, 'warn'); }
      };

      const delay = stealthDelay();
      if ('requestIdleCallback' in window) {
        try { requestIdleCallback(() => setTimeout(safeRemove, delay)); } catch (e) { setTimeout(safeRemove, delay); }
      } else {
        setTimeout(safeRemove, delay);
      }
    } catch (e) {
      logDebug(`Error during element blocking: ${e.message}`, 'error');
    }
  }

  /**
   * Gets the src attribute from an iframe.
   */
  function getIframeSrc(iframe) {
    try {
      if (!iframe) return null;
      if (iframe.src && iframe.src.trim()) return iframe.src;
      if (iframe.hasAttribute && iframe.hasAttribute('srcdoc')) return 'srcdoc';
      const attr = iframe.getAttribute && (iframe.getAttribute('src') || iframe.getAttribute('data-src'));
      if (attr) return attr;
      return null;
    } catch(e){ return null; }
  }

  /**
   * (v40.1.1) Processes a single iFrame, blocking or sandboxing it.
   * Patched: Safer sandboxing and error handling.
   */
  function handlePotentialIframe(iframe) {
    try {
      if (!iframe || iframe.hasAttribute('data-cp-removed')) return;
      const src = getIframeSrc(iframe);
      if (!src || src === 'srcdoc' || /^about:blank$/i.test(src)) return;

      const reason = checkBlockList(src);
      if (reason) {
          blockElement(iframe, `${reason} (iframe: ${src})`, 'iframe');
          return;
      }
      
      const w = iframe.width || iframe.getAttribute('width') || iframe.clientWidth || 0;
      const h = iframe.height || iframe.getAttribute('height') || iframe.clientHeight || 0;
      const smallHidden = (Number(w) && Number(w) < 6) || (Number(h) && Number(h) < 6) || (iframe.style && (iframe.style.opacity === '0' || iframe.style.display === 'none'));
      if (config.blockingMode === 'Aggressive' && smallHidden) {
          blockElement(iframe, 'Small/hidden iframe heuristic', 'iframe');
          return;
      }
      
      let url;
      try { url = new URL(src, location.href); } catch(e) { url = null; }
      
      if (config.blockingMode === 'Aggressive' && url && url.hostname && url.hostname !== location.hostname) {
          // stealth sandboxing: store original src, remove src, set sandbox to reduce risk
          try {
              // --- PATCH 3 (Consistency) ---
              iframe.setAttribute('data-cp-removed', 'true');
              iframe.dataset.cp_orig_src = src;
              
              setTimeout(() => {
                  try {
                      // --- PATCH 1 (Security) ---
                      iframe.setAttribute('sandbox', ''); // Most restrictive sandbox
                      iframe.removeAttribute('src');
                      stats.blockedIframes++;
                      stats.blockedTotal++;
                      scheduleSaveState();
                      logFilter('BLOCKED', url.hostname, 'Aggressive cross-origin iframe sandboxed (stealth)');
                      if (config.safeViewOpen) updateSafeViewUI();
                  } catch (e) { logDebug(`sandboxing iframe failed: ${e.message}`, 'warn'); }
              }, stealthDelay());
          } catch (e) { logDebug(`handlePotentialIframe sandbox error: ${e.message}`, 'warn'); }
      }
    } catch(e){ logDebug('handlePotentialIframe error: '+(e && e.message ? e.message : e),'warn'); }
  }

  /**
   * Scans the document for all iFrames.
   */
  function iframeBlockerScan(rootNode = document) {
    if (isPaused || !config.enabled || !config.useIframeBlocker) return;
    try {
      rootNode.querySelectorAll('iframe, frame').forEach(handlePotentialIframe);
    } catch (e) {
      logDebug(`Iframe blocking scan failed: ${e.message}`, 'error');
    }
  }

  /**
   * (v40.1.1) Builds the list of active heuristic CSS selectors based on mode.
   * Patched: Flattens array and filters empty values.
   */
  function getActiveHeuristicSelectors() {
      try {
          const alwaysSelectors = (config.heuristics || [])
            .filter(h => h && h.scope === 'always')
            .map(h => h.selector)
            .filter(Boolean);

          let activeSelectors = [...alwaysSelectors];

          if (config.blockingMode === 'Aggressive') {
              const aggressiveSelectors = (config.heuristics || [])
                .filter(h => h && h.scope === 'aggressive')
                .map(h => h.selector)
                .filter(Boolean);
              activeSelectors.push(...aggressiveSelectors);

              if (config.learnedSelectorList && config.learnedSelectorList.size > 0) {
                  activeSelectors.push(...Array.from(config.learnedSelectorList));
              }
          }

          // Flatten & unique
          return Array.from(new Set(activeSelectors.flat()));
      } catch (e) {
          logDebug(`getActiveHeuristicSelectors error: ${e.message}`, 'warn');
          return [];
      }
  }

  /**
   * (v40.1.1) Mutation observer callback to check for new elements.
   * Patched: Uses robust matchesAny and safer selector joining.
   */
  function handleMutation(mutations) {
    try {
      if (isPaused || !config.enabled || !config.useMutationObserver) return;

      const activeSelectors = getActiveHeuristicSelectors();
      // No need to pre-validate, matchesAny() is already robust
      if (activeSelectors.length === 0) return;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (!node || node.nodeType !== 1) return; // Not an ELEMENT_NODE
            
            // 1. Check node itself for selectors
            try {
              if (matchesAny(node, activeSelectors)) {
                  let reason = 'Heuristic Selector Match';
                  if (config.blockingMode === 'Aggressive') {
                      reason = 'Aggressive Selector Match';
                  }
                  // Check if it was a user-zapped rule
                  const userRule = config.heuristics.find(h => h.comment && h.comment.startsWith('User Zapped') && node.matches(h.selector));
                  if (userRule) reason = 'User Zapped Rule';

                  blockElement(node, reason, 'mutation');
                  return;
              }
            } catch (e) {}

            // 2. Check for iframes
            try {
              if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
                  handlePotentialIframe(node);
              }
            } catch (e) {}
            
            // 3. Check for new anchor tags (Performance Patch)
            try {
              if (config.usePopupBlocker && typeof node.querySelectorAll === 'function') {
                  if (node.tagName === 'A' && node.hasAttribute('target')) {
                      handleAnchorTags(node.parentElement || document.body); // Check this specific new anchor
                  } else {
                      handleAnchorTags(node); // Scan inside the new container node
                  }
              }
            } catch (e) {}

            // 4. Deep check inside the added node
            try {
                const nestedIframes = node.querySelectorAll('iframe, frame');
                nestedIframes.forEach(handlePotentialIframe);

                if (activeSelectors.length) {
                    // build a safe selector string
                    const safeSelectors = activeSelectors.join(',');
                    const nestedBlockable = node.querySelectorAll(safeSelectors);
                    nestedBlockable.forEach(el => {
                        blockElement(el, 'Heuristic Selector Match (nested)', 'mutation');
                    });
                }
            } catch (e) { /* Node might not support querySelectorAll */ }

            // 5. (v39) Scan new node for shadow roots
            if (config.useShadowDOMScanner) {
                scanForShadowRoots(node, 0); // Patched: pass depth
            }
          });
        }
      }
    } catch (e) {
      logDebug(`Mutation handling failed: ${e.message}`, 'error');
    }
  }

  // Main observer for the document
  let mainObserver;
  function initMutationObserver(rootNode = document.documentElement, isShadowRoot = false) {
    if (!config.useMutationObserver) return;
    if (!rootNode) return;

    try {
        const observer = new MutationObserver(handleMutation);
        observer.observe(rootNode, {
          childList: true,
          subtree: true,
        });

        if (isShadowRoot) {
            shadowObserverList.push(observer); // Keep track to disconnect later
            logDebug(`Mutation Observer attached to new shadowRoot.`);
        } else {
            mainObserver = observer; // This is the main document observer
        }
    } catch (e) {
        logDebug(`Failed to initialize Mutation Observer: ${e.message}`, 'error');
    }
  }

  /**
   * (v39) Recursively scans for and observes shadow roots.
   * (v40.1.1) Patched: Includes recursion depth guard.
   */
  function scanForShadowRoots(node, depth = 0) {
      try {
          if (!node || typeof node.querySelectorAll !== 'function') return;
          if (depth > 10) return; // avoid runaway recursion

          // Check the node itself
          if (node.shadowRoot) {
              const root = node.shadowRoot;
              initMutationObserver(root, true); // Attach a new observer
              iframeBlockerScan(root); // Run initial iframe scan
              scanForShadowRoots(root, depth + 1); // Recurse inside the shadow root
          }
          // --- PATCH 2 (Performance) ---
          // Scan children (optimized query)
          node.querySelectorAll('*:not(script):not(style)').forEach(child => {
              if (child.shadowRoot) {
                  const root = child.shadowRoot;
                  initMutationObserver(root, true);
                  iframeBlockerScan(root);
                  scanForShadowRoots(root, depth + 1);
              }
          });
      } catch (e) {
          logDebug(`Shadow DOM scan error: ${e.message}`, 'warn');
      }
  }

  /**
   * (v39) Disconnects all shadow DOM observers.
   */
  function disconnectShadowObservers() {
      try {
        shadowObserverList.forEach(obs => obs.disconnect());
        shadowObserverList = [];
        logDebug('All Shadow DOM observers disconnected.');
      } catch (e) { logDebug(`disconnectShadowObservers error: ${e.message}`, 'warn'); }
  }

  /**
   * (v39) Applies scriptlet replacements to a script's text.
   * (v40.1.1) Patched: Safely escapes s.find if it's a string.
   */
  function applyScriptlet(scriptText, url) {
      if (!config.useScriptletInjection) return scriptText;
      let modifiedText = scriptText;
      let applied = false;
      try {
          for (const s of config.scriptlets) {
              if (!s || !s.pattern) continue;
              // Check if a URL pattern is specified and if it matches
              if (url && url.includes(s.pattern)) {
                  try {
                      // escape 'find' for safe RegExp
                      let find = s.find;
                      let reg;
                      if (typeof find === 'string') {
                        reg = new RegExp(escapeRegExp(find), 'g');
                      } else {
                        // if it's already a regex object (advanced use)
                        reg = find;
                      }
                      modifiedText = modifiedText.replace(reg, s.replace);
                      applied = true;
                  } catch (e) {
                      logDebug(`applyScriptlet single replacement error for ${url}: ${e.message}`, 'warn');
                      continue;
                  }
              }
          }
          if (applied) logDebug(`Scriptlet applied to: ${url}`);
      } catch (e) {
          logDebug(`Scriptlet injection failed: ${e.message}`, 'error');
      }
      return modifiedText;
  }

  /**
   * (v40.1.1) Intercepts `fetch` API calls.
   * Patched: Stealth wrapper, full try/catch, and correct content-length setting.
   */
  function fetchInterceptor() {
    try {
      if (!config.enabled || !config.useFetchInterceptor) return;

      const originalFetch = window.fetch;
      if (!originalFetch || originalFetch.__cp_wrapped) return; // Already wrapped

      async function cpFetch(resource, options) {
        try {
          let url = (typeof resource === 'string') ? resource : (resource instanceof Request) ? resource.url : '';
          if (!url) return originalFetch.apply(this, arguments);

          // --- Critical Patch: Check relief against REQUEST host ---
          let requestHost = null;
          try {
            requestHost = (new URL(url, location.href)).hostname.toLowerCase();
          } catch (e) { requestHost = url ? String(url).toLowerCase() : null; }

          const isRelievedForRequest = requestHost && Array.from(reliefDomains.keys()).some(k => requestHost === k || requestHost.endsWith('.' + k));
          if (isRelievedForRequest || isPaused) {
            return originalFetch.apply(this, arguments);
          }
          // --- End Patch ---

          // 1. Request Blocking
          const reason = checkBlockList(url);
          if (reason) {
            stats.blockedFetches++;
            stats.blockedTotal++;
            logFilter('BLOCKED', url, `${reason} (Fetch)`);
            if (config.safeViewOpen) updateSafeViewUI();
            scheduleSaveState();
            // --- Critical Patch: Return 204 instead of 0 ---
            return Promise.resolve(new Response('', { status: 204, statusText: 'CleanPage Blocked' }));
          }
          
          // 2. Request Allowed - Check for Scriptlet Injection
          const response = await originalFetch.apply(this, arguments);
          if (config.useScriptletInjection && config.scriptlets && config.scriptlets.length > 0) {
              try {
                  const contentType = response.headers.get('content-type') || '';
                  if (contentType.includes('javascript') || contentType.includes('text/plain') || contentType.includes('application/ecmascript')) {
                      const scriptText = await response.text();
                      const modifiedText = applyScriptlet(scriptText, url);
                      
                      // clone headers and ensure content-length is correct
                      const headers = new Headers(response.headers);
                      headers.set('content-length', String(modifiedText.length));
                      return new Response(modifiedText, {
                          status: response.status,
                          statusText: response.statusText,
                          headers: headers
                      });
                  }
              } catch (e) {
                  logDebug(`Scriptlet read error for ${url}: ${e.message}`, 'warn');
                  return response; // Return original response on error
              }
          }

          // 3. No scriptlet, just pass through
          return response;
        } catch (e) {
            // on unexpected error, fallback to original fetch
            try { return originalFetch.apply(this, arguments); } catch (err) { throw err; }
        }
      }

      // Copy harmless properties and mark wrapped
      try {
        cpFetch.__cp_wrapped = true;
        window.fetch = cpFetch;
        try { window.fetch.toString = () => originalFetch.toString(); } catch (e) {}
        window.fetch.__cp_wrapped = true;
        logDebug('Fetch Interceptor (with Scriptlets) initialized.');
      } catch (e) {
        logDebug(`Failed to install fetch interceptor: ${e.message}`, 'error');
      }
    } catch (e) {
      logDebug(`fetchInterceptor error: ${e.message}`, 'error');
    }
  }

  /**
   * (v40.1.1) Intercepts `XMLHttpRequest` API calls.
   * Patched: Safer with more try/catch.
   */
  function wrapXHR() {
    try {
      if (!config.useXHRInterceptor) return;
      if (XMLHttpRequest.prototype.__cp_wrapped) return;

      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;
      
      XMLHttpRequest.prototype.open = function (method, url) {
        try { this.__cp_open_args = { method, url: String(url) }; } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      
      XMLHttpRequest.prototype.send = function (body) {
        try {
          const info = this.__cp_open_args || {};
          const url = info.url || '';
          if (!url) return origSend.apply(this, arguments); // Guard
          
          // --- Critical Patch: Check relief against REQUEST host ---
          let requestHost = null;
          try {
            requestHost = (new URL(url, location.href)).hostname.toLowerCase();
          } catch (e) { requestHost = String(url).toLowerCase(); }

          const isRelievedForRequest = requestHost && Array.from(reliefDomains.keys()).some(k => requestHost === k || requestHost.endsWith('.' + k));

          if (isRelievedForRequest || isPaused) {
            return origSend.apply(this, arguments); // Allow
          }
          // --- End Patch ---
          
          if (!isPaused && url) {
            const reason = checkBlockList(url);
            if (reason) {
              stats.blockedFetches++; // Count XHR under fetches
              stats.blockedTotal++;
              scheduleSaveState();
              logFilter('BLOCKED', url, `${reason} (XHR)`);
              if (config.safeViewOpen) updateSafeViewUI();
              try { this.abort(); } catch(e){}
              return;
            }
          }
        } catch(e){ /* swallow */ }
        return origSend.apply(this, arguments);
      };
      
      XMLHttpRequest.prototype.__cp_wrapped = true;
      logDebug('XHR Interceptor (Request Blocking) initialized.');
    } catch (e) {
        logDebug(`wrapXHR error: ${e.message}`, 'error');
    }
  }


  /*************** Popup / New Tab Blocking Module (Patched) ***************/

  // --- PATCH 4 (Performance) ---
  /**
   * Scans a given node for <a> tags and applies click listeners.
   */
  function handleAnchorTags(rootNode = document) {
    try {
      if (!config.usePopupBlocker) return;
      const anchors = rootNode.tagName === 'A' ? [rootNode] : rootNode.querySelectorAll('a[target]');
      anchors.forEach(anchor => {
        if (anchor.hasAttribute('data-cp-processed')) return;
        anchor.setAttribute('data-cp-processed', 'true');
        if (anchor.getAttribute('target') === '_blank') {
            // remove target to prevent native new tab behavior; we'll open selectively
            anchor.removeAttribute('target');
        }
        anchor.addEventListener('click', (e) => {
            try {
                const isRelievedDomain = Array.from(reliefDomains.keys()).some(k => k === DOMAIN || DOMAIN.endsWith('.' + k));
                if (isRelievedDomain || isPaused || !config.usePopupBlocker) return;
                const href = anchor.getAttribute('href') || '';
                const reason = checkBlockList(href);
                
                if (reason || anchor.getAttribute('onclick') || anchor.getAttribute('onmousedown')) {
                    e.preventDefault(); e.stopPropagation();
                    stats.popupBlocked++; stats.blockedTotal++;
                    logFilter('BLOCKED', href || 'Anchor Click', reason || 'Targeted Anchor Click Block');
                    if (config.safeViewOpen) updateSafeViewUI();
                    scheduleSaveState();
                    // only navigate in current tab if link is benign
                    if (href && !href.startsWith('javascript:') && href !== '#') {
                        setTimeout(() => { try { window.location.href = href; } catch (err) {} }, stealthDelay()); 
                    }
                    return false;
                }
            } catch (err) {}
        }, true); 
      });
    } catch (e) { logDebug(`handleAnchorTags error: ${e.message}`, 'warn'); }
  }

  /**
   * (v40.1.1) Overrides window.open
   * Patched: Stealth wrapper, wrapper guard, and allows benign 'about:blank'.
   * (PATCH 4): Removed setInterval and document-wide scan.
   */
  function popupNewTabBlocker() {
    try {
      if (isPaused || !config.enabled || !config.usePopupBlocker) return;
      
      // 1. Intercept window.open
      const originalWindowOpen = window.open;
      if (window.open && window.open.__cp_wrapped) {
          // already wrapped
      } else {
        window.open = function cpWindowOpen(url, name, features) {
            const isRelievedDomain = Array.from(reliefDomains.keys()).some(k => k === DOMAIN || DOMAIN.endsWith('.' + k));
            try {
              if (isRelievedDomain || isPaused || !config.usePopupBlocker) {
                  return originalWindowOpen.apply(this, arguments);
              }
              const reason = checkBlockList(url || '');
              if (reason) {
                stats.popupBlocked++; stats.blockedTotal++;
                logFilter('BLOCKED', url || 'No URL', `${reason} (window.open)`);
                if (config.safeViewOpen) updateSafeViewUI();
                scheduleSaveState();
                return { closed: true, close: () => {}, focus: () => {}, blur: () => {} };
              }
              // detect javascript: and other suspicious calls
              // (v40.1.1: allow 'about:blank' for OAuth/payment popups)
              if (!url || /^javascript:/i.test(String(url))) {
                stats.popupBlocked++; stats.blockedTotal++;
                logFilter('BLOCKED', url || 'No URL', 'Window.open Heuristic');
                if (config.safeViewOpen) updateSafeViewUI();
                scheduleSaveState();
                return { closed: true, close: () => {}, focus: () => {}, blur: () => {} };
              }
            } catch (e) {
                // on error, fallback
                try { return originalWindowOpen.apply(this, arguments); } catch (err) { return null; }
            }
            return originalWindowOpen.apply(this, arguments);
        };
        try { window.open.toString = () => originalWindowOpen.toString(); } catch (e) {}
        window.open.__cp_wrapped = true;
        logDebug('window.open successfully hijacked.');
      }
      // (PATCH 4): Removed anchor tag handling and setInterval from this function.
      // It's now handled by onDOMLoaded and handleMutation.
      logDebug('Anchor Tag Listener (MO-driven) initialized.');
    } catch (e) {
        logDebug(`popupNewTabBlocker error: ${e.message}`, 'error');
    }
  }
  // --- END PATCH 4 ---


  /*************** VITAL: Privacy Hijacking (v39) ***************/

  /**
   * (v39) Hijacks common fingerprinting properties.
   * (v40.1.1: Patched with safety)
   */
  function applyAntiFingerprinting() {
      if (!config.useAntiFingerprinting) return;
      try {
          if (navigator.plugins) Object.defineProperty(navigator, 'plugins', { get: () => [] });
          if (navigator.mimeTypes) Object.defineProperty(navigator, 'mimeTypes', { get: () => [] });
          Object.defineProperty(screen, 'width', { get: () => 1920 });
          Object.defineProperty(screen, 'height', { get: () => 1080 });
          Object.defineProperty(screen, 'availWidth', { get: () => 1920 });
          Object.defineProperty(screen, 'availHeight', { get: () => 1080 });
          const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
          HTMLCanvasElement.prototype.toDataURL = function() {
              logDebug('Canvas.toDataURL call intercepted (Anti-Fingerprinting)', 'warn');
              return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
          };
          logDebug('VITAL: Anti-Fingerprinting measures applied.', 'info');
      } catch (e) {
          logDebug(`VITAL: Anti-Fingerprinting failed (may be strict CSP): ${e.message}`, 'error');
      }
  }
  
  /**
   * (v39) Prevents WebRTC IP Leaks.
   * (v40.1.1: Patched with safety)
   */
  function applyWebRTCLeakProtection() {
      if (!config.useWebRTCLeakProtection) return;
      try {
          const originalRTC = window.RTCPeerConnection;
          if (!originalRTC) return;
          const cpRTC = function(config, ...args) {
              if (config && config.iceServers) {
                  config.iceServers = [{ urls: "stun:none.none" }];
              }
              if (config) config.iceTransportPolicy = 'relay';
              return new originalRTC(config, ...args);
          };
          cpRTC.prototype = originalRTC.prototype;
          window.RTCPeerConnection = cpRTC;
          logDebug('VITAL: WebRTC IP Leak Protection applied.', 'info');
      } catch (e) {
          logDebug(`VITAL: WebRTC protection failed: ${e.message}`, 'error');
      }
  }

  /**
   * (v36) Hijacks Storage APIs (localStorage, sessionStorage).
   * (v40.1.1: Patched with safety)
   */
  function initStorageIsolation() {
    if (!config.useStorageIsolation) return;
    try {
      ['localStorage', 'sessionStorage'].forEach(type => {
        const originalStorage = window[type];
        const isolatedStorage = new Map();
        Object.defineProperty(window, type, {
          value: {
            getItem: (key) => isolatedStorage.has(key) ? isolatedStorage.get(key) : originalStorage.getItem(key),
            setItem: (key, value) => {
              logDebug(`[Storage Intercept] WRITE BLOCKED: ${type}.${key} (isolated)`, 'warn');
              isolatedStorage.set(key, String(value));
            },
            removeItem: (key) => isolatedStorage.delete(key),
            clear: () => isolatedStorage.clear(),
            key: (index) => Array.from(isolatedStorage.keys())[index],
            get length() { return isolatedStorage.size; }
          },
          writable: false, configurable: false
        });
      });
      logDebug('VITAL: Storage Isolation Hijacking initialized.', 'info');
    } catch (e) {
      logDebug(`VITAL: Storage Isolation failed (may be strict CSP): ${e.message}`, 'error');
    }
  }

  /*************** Element Zapper (v40.1.1 - Patched) ***************/

  function zapperHighlight(e) {
      try { e.preventDefault(); e.stopPropagation(); if (e.target) e.target.classList.add('cp-zapper-highlight'); } catch (e) {}
  }
  function zapperClearHighlight(e) {
      try { e.preventDefault(); e.stopPropagation(); if (e.target) e.target.classList.remove('cp-zapper-highlight'); } catch (e) {}
  }
  function zapperKeydown(e) {
      if (e.key === 'Escape') {
          try { e.preventDefault(); e.stopPropagation(); } catch (err) {}
          deactivateZapper();
      }
  }

  /**
   * (v40) Generates a stable selector for the Zapper.
   * (v40.1.1: Patched with safety)
   */
  function generateZapperSelector(el) {
      try {
        if (el.id) {
            const selector = `#${cssEscape(el.id)}`;
            if (document.querySelectorAll(selector).length === 1) return selector;
        }
        if (el.className && typeof el.className === 'string') {
            const classes = el.className.split(/\s+/).filter(Boolean);
            if (classes.length > 0) {
                const classSelector = el.tagName.toLowerCase() + classes.map(c => '.' + cssEscape(c)).join('');
                if (document.querySelectorAll(classSelector).length === 1) return classSelector;
                
                const fullClassSelector = `${el.tagName.toLowerCase()}[class="${el.className}"]`;
                if (document.querySelectorAll(fullClassSelector).length === 1) return fullClassSelector;
            }
        }
        const dataAttr = Array.from(el.attributes || []).find(a => a.name && a.name.startsWith('data-') && a.value);
        if (dataAttr) {
             const dataSelector = `${el.tagName.toLowerCase()}[${dataAttr.name}="${dataAttr.value}"]`;
             if (document.querySelectorAll(dataSelector).length === 1) return dataSelector;
        }
      } catch (e) { logDebug(`generateZapperSelector error: ${e.message}`, 'warn'); }
      return el.tagName.toLowerCase();
  }

  /**
   * (v40) Handles the click event in Zapper mode.
   * (v40.1.1: Patched with safety)
   */
  function zapperClick(e) {
      try {
          e.preventDefault(); e.stopPropagation();
          const el = e.target;
          const selector = generateZapperSelector(el);
          const count = document.querySelectorAll(selector).length;
          
          const confirmed = confirm(
              `[CleanPage Zapper]\n\nSelector:\n${selector}\n\n` +
              `This selector matches ${count} element(s). Add this rule to your Heuristics list?`
          );
          
          if (confirmed) {
              config.heuristics.push({
                  selector: selector,
                  scope: 'always', // Zapped elements should always be blocked
                  comment: `User Zapped on ${DOMAIN}`
              });
              saveConfig();
              blockElement(el, 'User Zapped', 'mutation');
              if (config.safeViewOpen) updateSafeViewUI(); 
          }
          deactivateZapper();
      } catch (e) { logDebug(`zapperClick error: ${e.message}`, 'warn'); deactivateZapper(); }
  }

  /**
   * (v40) Activates the Zapper mode.
   * (v40.1.1: Patched with safety, appends to documentElement)
   */
  function activateZapper() {
      if (isZapperActive) return;
      isZapperActive = true;
      try { if (config.safeViewOpen) hideSafeView(); } catch (e) {}
      logDebug('Zapper Mode Activated. Press ESC to cancel.', 'warn');
      
      try {
        if (!zapperToast) {
            zapperToast = document.createElement('div');
            zapperToast.id = 'cp-zapper-toast';
            zapperToast.innerHTML = `⚡ Zapper Mode Active (Press ESC to Cancel)`;
            document.documentElement.appendChild(zapperToast);
        }
        zapperToast.style.display = 'block';
      } catch (e) {}

      document.addEventListener('mouseover', zapperHighlight, true);
      document.addEventListener('mouseout', zapperClearHighlight, true);
      document.addEventListener('click', zapperClick, true);
      document.addEventListener('keydown', zapperKeydown, true);
  }

  /**
   * (v40) Deactivates the Zapper mode.
   * (v40.1.1: Patched with safety)
   */
  function deactivateZapper() {
      if (!isZapperActive) return;
      isZapperActive = false;
      logDebug('Zapper Mode Deactivated.', 'info');
      
      try { if (zapperToast) zapperToast.style.display = 'none'; } catch (e) {}
      try { document.querySelectorAll('.cp-zapper-highlight').forEach(el => el.classList.remove('cp-zapper-highlight')); } catch (e) {}

      document.removeEventListener('mouseover', zapperHighlight, true);
      document.removeEventListener('mouseout', zapperClearHighlight, true);
      document.removeEventListener('click', zapperClick, true);
      document.removeEventListener('keydown', zapperKeydown, true);
  }


  /*************** SafeView UI & Menu (Full v40.1) ***************/

  // *** SAFE_VIEW_CSS (v36.5.5 + v40 Zapper) ***
  const SAFE_VIEW_CSS = `
    /* Modal Core */
    .cp-modal {
        font-family: 'Inter', sans-serif;
        --cp-bg-dark: #1e1e1e; --cp-bg-light: #2b2e31; --cp-text-light: #f0f0f0;
        --cp-primary: #4CAF50; --cp-secondary: #007bff; --cp-red: #dc3545;
        --cp-blue-light: #2c9aff; --cp-orange: #ff9800;
        z-index: 100000; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background-color: rgba(0, 0, 0, 0.85); display: flex;
        justify-content: center; align-items: center; backdrop-filter: blur(5px);
    }
    .cp-modal-content {
        background: var(--cp-bg-dark); color: var(--cp-text-light); padding: 20px;
        border-radius: 12px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
        max-width: 95%; width: 900px; max-height: 95vh;
        display: flex; flex-direction: column;
    }
    /* Header & Tabs */
    .cp-header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 15px; margin-bottom: 15px; border-bottom: 2px solid var(--cp-bg-light); }
    .cp-header h2 { margin: 0; font-size: 1.5rem; font-weight: 700; }
    .cp-close-btn { background: none; border: none; color: var(--cp-text-light); font-size: 24px; cursor: pointer; opacity: 0.7; padding: 5px; line-height: 1; transition: opacity 0.2s; }
    .cp-close-btn:hover { opacity: 1; }
    .cp-tabs { display: flex; flex-wrap: wrap; margin-bottom: 10px; border-bottom: 1px solid #444; }
    .cp-tab-btn { background: var(--cp-bg-light); color: var(--cp-text-light); border: none; padding: 10px 15px; cursor: pointer; font-size: 0.9rem; border-radius: 8px 8px 0 0; margin-right: 5px; transition: background 0.2s, color 0.2s; }
    .cp-tab-btn:hover { background: #444; }
    .cp-tab-btn.active { background: var(--cp-primary); color: var(--cp-bg-dark); font-weight: bold; }
    .cp-tab-content { flex-grow: 1; overflow-y: auto; padding: 10px 0; }
    /* UI Elements */
    .cp-setting-item { display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px dashed #333; }
    .cp-setting-item:last-child { border-bottom: none; }
    .cp-log-entry { font-family: monospace; font-size: 0.8rem; white-space: pre-wrap; word-break: break-all; border-bottom: 1px dotted #333; padding: 5px 0; }
    .cp-log-entry.BLOCKED { color: var(--cp-red); }
    .cp-log-entry.ALLOWED { color: var(--cp-primary); }
    .cp-log-entry.ERROR { color: #ff9800; }
    .cp-list-management { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 15px; }
    .cp-list-col { background: var(--cp-bg-light); padding: 15px; border-radius: 8px; display: flex; flex-direction: column; max-height: 40vh; }
    .cp-list-col h4 { margin-top: 0; font-size: 1.1rem; }
    .cp-list-textarea { width: 100%; height: 150px; background: #111; color: var(--cp-text-light); border: 1px solid #444; padding: 10px; resize: vertical; font-family: monospace; font-size: 0.9rem; border-radius: 6px; }
    .cp-list-textarea[readonly] { color: #888; }
    .cp-button { background: var(--cp-primary); color: var(--cp-bg-dark); border: none; padding: 8px 15px; cursor: pointer; border-radius: 6px; font-weight: bold; transition: background 0.2s, transform 0.1s; margin-top: 10px; }
    .cp-button:hover { background: #5cb85c; }
    .cp-button-red { background: var(--cp-red); color: var(--cp-text-light); }
    .cp-button-red:hover { background: #c82333; }
    .cp-button-blue { background: var(--cp-secondary); color: var(--cp-text-light); }
    .cp-button-blue:hover { background: #0056b3; }
    .cp-button-green { background: var(--cp-primary); color: var(--cp-bg-dark); }
    .cp-button-green:hover { background: #5cb85c; }
    .cp-button-orange { background: var(--cp-orange); color: var(--cp-bg-dark); }
    .cp-button-orange:hover { background: #e68a00; }
    /* Stats Bars */
    .cp-bar-container { height: 15px; background: #333; border-radius: 4px; margin-top: 5px; overflow: hidden; }
    .cp-bar { height: 100%; transition: width 0.5s ease-out; text-align: right; font-size: 0.7rem; color: var(--cp-bg-dark); line-height: 15px; font-weight: bold; padding-right: 5px; }
    .cp-bar-iframe { background-color: #f39c12; }
    .cp-bar-fetch { background-color: #3498db; }
    .cp-bar-mutation { background-color: #e74c3c; }
    .cp-bar-popup { background-color: #9b59b6; }
    /* Heuristics Tab */
    .cp-heur-item { background: #111; padding: 8px; border-radius: 4px; margin-bottom: 5px; display: flex; justify-content: space-between; align-items: center; }
    .cp-heur-item code { color: #f0f0f0; }
    .cp-heur-item small { color: #aaa; }
    /* v40 Zapper */
    .cp-zapper-highlight { outline: 2px dashed #dc3545 !important; background-color: rgba(220, 53, 69, 0.2) !important; box-shadow: 0 0 10px rgba(220, 53, 69, 0.5) !important; cursor: crosshair !important; }
    #cp-zapper-toast { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: var(--cp-red); color: var(--cp-text-light); padding: 10px 20px; border-radius: 8px; font-family: 'Inter', sans-serif; font-size: 1rem; font-weight: 600; z-index: 2147483647; box-shadow: 0 4px 15px rgba(0,0,0,0.5); display: none; }
    /* Responsive */
    @media (max-width: 768px) {
        .cp-modal-content { max-width: 100%; height: 100vh; border-radius: 0; }
        .cp-list-management { grid-template-columns: 1fr; }
        .cp-tabs { overflow-x: auto; flex-wrap: nowrap; padding-bottom: 5px; }
        .cp-tab-btn { flex-shrink: 0; }
    }
  `;
  try { GM_addStyle(SAFE_VIEW_CSS); } catch (e) { logDebug(`GM_addStyle failed: ${e.message}`, 'error'); }

  /**
   * Toggles the main script enabled/disabled state.
   */
  function toggleScriptEnabled() {
    config.enabled = !config.enabled;
    saveConfig();
    logDebug(`Script ${config.enabled ? 'ENABLED' : 'DISABLED'}. Reloading...`, 'warn');
    updateSafeViewUI();
    setTimeout(() => window.location.reload(), 100);
  }

  /**
   * Toggles the Aggressive/Stealth blocking mode.
   */
  function toggleBlockingMode() {
      config.blockingMode = config.blockingMode === 'Aggressive' ? 'Stealth' : 'Aggressive';
      saveConfig();
      logDebug(`Blocking Mode set to: ${config.blockingMode}`);
      updateSafeViewUI();
  }

  /**
   * Toggles the global pause state.
   */
  function togglePause() {
      isPaused = !isPaused;
      logDebug(`Script is now ${isPaused ? 'PAUSED' : 'RESUMED'}.`);
      updateSafeViewUI();
  }

  /**
   * (v40.1.1) Toggles session relief for the current domain.
   * Patched: Correctly checks/sets relief for current DOMAIN.
   */
  function toggleDomainRelief(timeMinutes) {
    const isRelieved = Array.from(reliefDomains.keys()).some(k => k === DOMAIN || DOMAIN.endsWith('.' + k));
    if (isRelieved) {
      // remove any matching relief entries for current domain
      for (const key of Array.from(reliefDomains.keys())) {
        if (DOMAIN === key || DOMAIN.endsWith('.' + key)) reliefDomains.delete(key);
      }
      logDebug(`Session Relief CLEARED for ${DOMAIN}.`);
    } else {
      let expiry = null;
      let reason = 'Permanent Relief';
      if (timeMinutes && timeMinutes > 0) {
          expiry = Date.now() + timeMinutes * 60 * 1000;
          reason = `Timed Relief (${timeMinutes}m)`;
      }
      reliefDomains.set(DOMAIN, { expiry, reason });
      logDebug(`Session Relief SET for ${DOMAIN}: ${reason}`);
    }
    saveConfig();
    updateSafeViewUI();
  }


  /**
   * (v40.1) Updates the SafeView UI content.
   * This is the full-featured UI renderer.
   */
  function updateSafeViewUI() {
    const modal = document.getElementById('cp-safeview-modal');
    if (!modal || modal.style.display !== 'flex') return;

    // (v40.1.1) Patched check for relief
    const isRelieved = Array.from(reliefDomains.keys()).some(k => k === DOMAIN || DOMAIN.endsWith('.' + k));
    const reliefItem = reliefDomains.get(DOMAIN); // Get specific item for display
    let reliefStatusText = 'BLOCKING IS ACTIVE';
    let reliefColor = 'var(--cp-primary)';
    if (isRelieved) {
        const item = reliefItem || Array.from(reliefDomains.values()).find(v => DOMAIN.endsWith('.' + v.domain));
        reliefStatusText = (item && item.expiry === null) ? 'PERMANENTLY RELIEVED' : `RELIEVED (Expires ${item ? new Date(item.expiry).toLocaleTimeString() : '...'})`;
        reliefColor = 'var(--cp-red)';
    }

    // --- Overview Tab ---
    const overviewContent = document.getElementById('cp-tab-overview');
    if (overviewContent) {
        overviewContent.innerHTML = `
            <p><strong>CleanPage Status:</strong> ${config.enabled ? '<span style="color:var(--cp-primary);">ACTIVE</span>' : '<span style="color:var(--cp-red);">DISABLED</span>'}</p>
            <div class="cp-setting-item"><span>Total Blocked Items:</span><span>${stats.blockedTotal}</span></div>
            <div class="cp-setting-item"><span>Blocking Active on:</span><span style="color:${reliefColor};">${reliefStatusText}</span></div>
            <div class="cp-setting-item"><span>Script Version:</span><span>${VERSION}</span></div>
            <hr style="border-color: #333; margin: 15px 0;">
            <div class="cp-setting-item">
                <span><strong>Blocking Mode:</strong></span>
                <button id="cp-toggle-mode" class="cp-button cp-button-${config.blockingMode === 'Aggressive' ? 'orange' : 'green'}">
                    ${config.blockingMode === 'Aggressive' ? 'Aggressive Mode (Max Blocking)' : 'Stealth Mode (Max Evasion)'}
                </button>
            </div>
            <hr style="border-color: #333; margin: 15px 0;">
            <div class="cp-setting-item">
                <span><strong>Blocking State:</strong></span>
                <button id="cp-toggle-pause" class="cp-button cp-button-${isPaused ? 'green' : 'red'}">
                    ${isPaused ? 'Resume Blocking' : 'Pause Blocking'}
                </button>
            </div>
            
            <div class="cp-list-management" style="margin-top: 15px;">
                <div class="cp-list-col" style="max-height: none;">
                    <h4>Core Blockers</h4>
                    <div class="cp-setting-item"><span>Fetch Interceptor:</span><input type="checkbox" id="cp-toggle-fetch" ${config.useFetchInterceptor ? 'checked' : ''}></div>
                    <div class="cp-setting-item"><span>XHR Interceptor:</span><input type="checkbox" id="cp-toggle-xhr" ${config.useXHRInterceptor ? 'checked' : ''}></div>
                    <div class="cp-setting-item"><span>iFrame/Frame Blocker:</span><input type="checkbox" id="cp-toggle-iframe" ${config.useIframeBlocker ? 'checked' : ''}></div>
                    <div class="cp-setting-item"><span>DOM Mutation Observer:</span><input type="checkbox" id="cp-toggle-mutation" ${config.useMutationObserver ? 'checked' : ''}></div>
                    <div class="cp-setting-item"><span>Popup / New Tab Blocker:</span><input type="checkbox" id="cp-toggle-popup" ${config.usePopupBlocker ? 'checked' : ''}></div>
                    <div class="cp-setting-item"><span>Show Bar Stats:</span><input type="checkbox" id="cp-toggle-barstats" ${config.showBarStats ? 'checked' : ''}></div>
                </div>
                <div class="cp-list-col" style="max-height: none;">
                    <h4>Advanced Privacy & Features</h4>
                    <div class="cp-setting-item"><span>External Domain Blocklists:</span><input type="checkbox" id="cp-toggle-externallist" ${config.useExternalBlocklists ? 'checked' : ''}></div>
                    <div class="cp-setting-item"><span>Shadow DOM Scanner:</span><input type="checkbox" id="cp-toggle-shadow" ${config.useShadowDOMScanner ? 'checked' : ''}></div>
                    <div class="cp-setting-item"><span>Storage Isolation:</span><input type="checkbox" id="cp-toggle-storage" ${config.useStorageIsolation ? 'checked' : ''}></div>
                    <div class="cp-setting-item"><span>Anti-Fingerprinting:</span><input type="checkbox" id="cp-toggle-fingerprint" ${config.useAntiFingerprinting ? 'checked' : ''}></div>
                    <div class="cp-setting-item"><span>WebRTC IP Leak Protection:</span><input type="checkbox" id="cp-toggle-webrtc" ${config.useWebRTCLeakProtection ? 'checked' : ''}></div>
                    <div class="cp-setting-item"><span>Scriptlet Injection (Fetch):</span><input type="checkbox" id="cp-toggle-scriptlet" ${config.useScriptletInjection ? 'checked' : ''}></div>
                </div>
            </div>
        `;
        document.getElementById('cp-toggle-mode').onclick = toggleBlockingMode;
        document.getElementById('cp-toggle-pause').onclick = togglePause;
        
        // Add listeners for toggles
        const toggleMap = {
            'cp-toggle-fetch': 'useFetchInterceptor', 'cp-toggle-xhr': 'useXHRInterceptor',
            'cp-toggle-iframe': 'useIframeBlocker', 'cp-toggle-mutation': 'useMutationObserver',
            'cp-toggle-popup': 'usePopupBlocker', 'cp-toggle-barstats': 'showBarStats',
            'cp-toggle-externallist': 'useExternalBlocklists', // v40.1
            'cp-toggle-shadow': 'useShadowDOMScanner', 'cp-toggle-storage': 'useStorageIsolation',
            'cp-toggle-fingerprint': 'useAntiFingerprinting', 'cp-toggle-webrtc': 'useWebRTCLeakProtection',
            'cp-toggle-scriptlet': 'useScriptletInjection'
        };
        for (const [id, key] of Object.entries(toggleMap)) {
            const el = document.getElementById(id);
            if (el) {
                el.onchange = (e) => {
                    config[key] = e.target.checked;
                    saveConfig();
                    logDebug(`${key} ${e.target.checked ? 'Enabled' : 'Disabled'}. Reload may be required.`);
                    if (key === 'showBarStats') updateBarStats();
                };
            }
        }
    }

    // --- Stats Tab ---
    const statsContent = document.getElementById('cp-tab-stats');
    if (statsContent) {
        const total = stats.blockedTotal || 1;
        const pIframe = (stats.blockedIframes / total) * 100;
        const pFetch = (stats.blockedFetches / total) * 100;
        const pMutation = (stats.blockedMutations / total) * 100;
        const pPopup = (stats.popupBlocked / total) * 100;
        statsContent.innerHTML = `
            <p><strong>Session Start:</strong> ${new Date(stats.sessionStart).toLocaleString()}</p>
            <div class="cp-setting-item"><span><strong>TOTAL BLOCKED ITEMS:</strong></span><span style="font-size: 1.2rem; font-weight: bold; color: var(--cp-red);">${stats.blockedTotal}</span></div>
            <hr style="border-color: #333; margin: 15px 0;">
            <div class="cp-setting-item"><span>iFrames/Frames Blocked:</span><span>${stats.blockedIframes}</span></div>
            <div class="cp-setting-item"><span>Fetch/XHR Blocked:</span><span>${stats.blockedFetches}</span></div>
            <div class="cp-setting-item"><span>DOM Mutations Blocked:</span><span>${stats.blockedMutations}</span></div>
            <div class="cp-setting-item"><span>Popups / New Tabs Blocked:</span><span>${stats.popupBlocked}</span></div>
            <hr style="border-color: #333; margin: 15px 0;">
            <h4>Block Distribution (${stats.blockedTotal} Total)</h4>
            <p style="font-size: 0.8rem; margin-bottom: 5px;">iFrame (${pIframe.toFixed(1)}%)</p>
            <div class="cp-bar-container"><div class="cp-bar cp-bar-iframe" style="width: ${pIframe}%;">${stats.blockedIframes > 0 ? stats.blockedIframes : ''}</div></div>
            <p style="font-size: 0.8rem; margin-bottom: 5px;">Fetch/XHR (${pFetch.toFixed(1)}%)</p>
            <div class="cp-bar-container"><div class="cp-bar cp-bar-fetch" style="width: ${pFetch}%;">${stats.blockedFetches > 0 ? stats.blockedFetches : ''}</div></div>
            <p style="font-size: 0.8rem; margin-bottom: 5px;">Mutation (${pMutation.toFixed(1)}%)</p>
            <div class="cp-bar-container"><div class="cp-bar cp-bar-mutation" style="width: ${pMutation}%;">${stats.blockedMutations > 0 ? stats.blockedMutations : ''}</div></div>
            <p style="font-size: 0.8rem; margin-bottom: 5px;">Popup (${pPopup.toFixed(1)}%)</p>
            <div class="cp-bar-container"><div class="cp-bar cp-bar-popup" style="width: ${pPopup}%;">${stats.popupBlocked > 0 ? stats.popupBlocked : ''}</div></div>
        `;
    }

    // --- Relief Tab ---
    const reliefContent = document.getElementById('cp-tab-relief');
    if (reliefContent) {
        let reliefButtons = isRelieved ? 
            `<button id="cp-relief-clear" class="cp-button cp-button-green">Clear Relief</button>` :
            `<button id="cp-relief-10m" class="cp-button cp-button-blue" style="margin-right: 10px;">Relief 10 Min</button>
             <button id="cp-relief-30m" class="cp-button cp-button-blue" style="margin-right: 10px;">Relief 30 Min</button>
             <button id="cp-relief-perm" class="cp-button cp-button-orange">Permanent Relief</button>`;
        reliefContent.innerHTML = `
            <h4>Current Domain (${DOMAIN}) Status: <span style="color:${reliefColor};">${reliefStatusText}</span></h4>
            <p style="font-size: 0.9rem; margin-bottom: 20px;">Relief allows all external content (iFrames, Fetch, Popups) and disables DOM Mutation blocking for this domain.</p>
            <div style="display: flex; justify-content: center;">${reliefButtons}</div>
            <h4 style="margin-top: 30px; border-top: 1px dashed #333; padding-top: 15px;">Active Relief List</h4>
            <div id="cp-relief-list-container" style="max-height: 200px; overflow-y: auto;">
                ${Array.from(reliefDomains.entries()).map(([domain, data]) => {
                    const expiryText = data.expiry === null ? 'Permanent' : new Date(data.expiry).toLocaleString();
                    return `<div class="cp-setting-item" style="font-size: 0.85rem;">
                                <span>${domain}</span>
                                <span>${expiryText} <button class="cp-button cp-button-red cp-remove-relief" data-domain="${domain}" style="padding: 3px 8px; margin-left: 10px;">Remove</button></span>
                            </div>`;
                }).join('') || '<p style="font-style: italic;">No active relief domains.</p>'}
            </div>
        `;
        if (isRelieved) {
            document.getElementById('cp-relief-clear').onclick = () => toggleDomainRelief(0);
        } else {
            document.getElementById('cp-relief-10m').onclick = () => toggleDomainRelief(10);
            document.getElementById('cp-relief-30m').onclick = () => toggleDomainRelief(30);
            document.getElementById('cp-relief-perm').onclick = () => toggleDomainRelief(0);
        }
        document.querySelectorAll('.cp-remove-relief').forEach(btn => {
            btn.onclick = () => {
                reliefDomains.delete(btn.getAttribute('data-domain'));
                saveConfig();
                updateSafeViewUI();
            };
        });
    }

    // --- Domain Lists Tab (v40.1) ---
    const listsContent = document.getElementById('cp-tab-lists');
    if (listsContent) {
        listsContent.innerHTML = `
            <div class="cp-list-management" style="grid-template-columns: 1fr 1fr;">
                <div class="cp-list-col">
                    <h4>User Domain Block List (${config.userBlockList.size})</h4>
                    <p style="font-size: 0.8rem;">Domains you add manually. Checked first.</p>
                    <textarea id="cp-list-block" class="cp-list-textarea" placeholder="Enter one domain per line (e.g., tracking.net)">${Array.from(config.userBlockList).join('\n')}</textarea>
                    <button id="cp-list-save-block" class="cp-button cp-button-red">Save User List</button>
                </div>
                <div class="cp-list-col">
                    <h4>Domain Allow List (${config.allowList.size})</h4>
                    <p style="font-size: 0.8rem;">Bypasses all blocking (network and cosmetic).</p>
                    <textarea id="cp-list-allow" class="cp-list-textarea" placeholder="Enter one domain per line (e.g., example.com)">${Array.from(config.allowList).join('\n')}</textarea>
                    <button id="cp-list-save-allow" class="cp-button cp-button-green">Save Allow List</button>
                </div>
            </div>
            <div class="cp-list-management" style="margin-top: 20px; grid-template-columns: 1fr;">
                 <div class="cp-list-col" style="max-height: none;">
                    <h4>External "Lite" Blocklists</h4>
                    <div class="cp-setting-item">
                        <span>Cached Domains:</span>
                        <span style="font-weight: bold; color: var(--cp-primary);">${fetchedBlockList.size}</span>
                    </div>
                    <div class="cp-setting-item">
                        <span>Last Update:</span>
                        <span>${lastListUpdate ? new Date(lastListUpdate).toLocaleString() : 'Never'}</span>
                    </div>
                    <button id="cp-list-update-external" class="cp-button cp-button-blue">Update External Lists Now</button>
                    <h4 style="margin-top: 15px;">List Sources (Hosts Format)</h4>
                    <textarea id="cp-list-external-urls" class="cp-list-textarea" style="height: 80px;">${config.externalBlocklistURLs.join('\n')}</textarea>
                    <button id="cp-list-save-external-urls" class="cp-button cp-button-blue">Save Source URLs</button>
                </div>
            </div>
        `;
        const parseList = (id) => {
            const el = document.getElementById(id);
            return el ? el.value.split('\n').map(s => s.trim()).filter(s => s.length > 0) : [];
        };
        const btnSaveBlock = document.getElementById('cp-list-save-block');
        if (btnSaveBlock) btnSaveBlock.onclick = () => {
            config.userBlockList = new Set(parseList('cp-list-block'));
            saveConfig();
            logDebug('User Block List saved.');
            iframeBlockerScan(); 
        };
        const btnSaveAllow = document.getElementById('cp-list-save-allow');
        if (btnSaveAllow) btnSaveAllow.onclick = () => {
            config.allowList = new Set(parseList('cp-list-allow'));
            saveConfig();
            logDebug('Allow List saved.');
            iframeBlockerScan();
        };
        const btnUpdateExt = document.getElementById('cp-list-update-external');
        if (btnUpdateExt) btnUpdateExt.onclick = () => {
            logDebug('Forcing external list update...');
            updateExternalBlocklists(true); // true = force
            alert('Update started... see logs for progress. The UI will update when complete.');
        };
        const btnSaveExt = document.getElementById('cp-list-save-external-urls');
        if (btnSaveExt) btnSaveExt.onclick = () => {
            config.externalBlocklistURLs = parseList('cp-list-external-urls');
            saveConfig();
            logDebug('External list URLs saved.');
            alert('Source URLs saved. Update will occur on next scheduled run or if forced.');
        };
    }

    // --- Trackers Tab (v39: Added Scriptlets) ---
    const trackersContent = document.getElementById('cp-tab-trackers');
    if (trackersContent) {
        trackersContent.innerHTML = `
            <div class="cp-list-management">
                <div class="cp-list-col" style="max-height: none;">
                    <h4>Custom Tracker List (${config.customTrackers.length})</h4>
                    <p style="font-size: 0.8rem;">Manages tracker patterns (domains, paths) for network blockers. Edit as JSON.</p>
                    <textarea id="cp-list-trackers" class="cp-list-textarea" style="height: 250px;">${JSON.stringify(config.customTrackers, null, 2)}</textarea>
                    <div style="display: flex; justify-content: space-between; margin-top: 10px;">
                        <button id="cp-trackers-save" class="cp-button cp-button-blue">Save Tracker List</button>
                        <button id="cp-trackers-reset" class="cp-button cp-button-red">Reset to Defaults</button>
                    </div>
                </div>
                <div class="cp-list-col" style="max-height: none;">
                    <h4>Scriptlet Injection (${config.scriptlets.length})</h4>
                    <p style="font-size: 0.8rem;">Neutralizes scripts on-the-fly. Edit as JSON: {pattern, find, replace, comment}</p>
                    <textarea id="cp-list-scriptlets" class="cp-list-textarea" style="height: 250px;">${JSON.stringify(config.scriptlets, null, 2)}</textarea>
                    <div style="display: flex; justify-content: space-between; margin-top: 10px;">
                        <button id="cp-scriptlets-save" class="cp-button cp-button-blue">Save Scriptlet List</button>
                        <button id="cp-scriptlets-reset" class="cp-button cp-button-red">Reset to Defaults</button>
                    </div>
                </div>
            </div>
        `;
        // Tracker list logic
        const btnTrackSave = document.getElementById('cp-trackers-save');
        if (btnTrackSave) btnTrackSave.onclick = () => {
            try {
                const newList = JSON.parse(document.getElementById('cp-list-trackers').value);
                if (Array.isArray(newList)) {
                    config.customTrackers = newList;
                    saveConfig(); logDebug('Custom Tracker list saved.');
                    alert('Trackers saved!');
                } else { alert('Invalid format. Must be a JSON array.'); }
            } catch (e) { alert(`Error saving: ${e.message}`); }
        };
        const btnTrackReset = document.getElementById('cp-trackers-reset');
        if (btnTrackReset) btnTrackReset.onclick = async () => {
            if (await promptConfirmation('Reset the tracker list to defaults?')) {
                config.customTrackers = DEFAULT_TRACKERS;
                saveConfig(); logDebug('Custom Tracker list reset.');
                updateSafeViewUI();
            }
        };
        // Scriptlet list logic
        const btnScriptSave = document.getElementById('cp-scriptlets-save');
        if (btnScriptSave) btnScriptSave.onclick = () => {
            try {
                const newList = JSON.parse(document.getElementById('cp-list-scriptlets').value);
                if (Array.isArray(newList)) {
                    config.scriptlets = newList;
                    saveConfig(); logDebug('Scriptlet list saved.');
                    alert('Scriptlets saved!');
                } else { alert('Invalid format. Must be a JSON array.'); }
            } catch (e) { alert(`Error saving: ${e.message}`); }
        };
        const btnScriptReset = document.getElementById('cp-scriptlets-reset');
        if (btnScriptReset) btnScriptReset.onclick = async () => {
            if (await promptConfirmation('Reset the scriptlet list to defaults?')) {
                config.scriptlets = DEFAULT_SCRIPTLETS;
                saveConfig(); logDebug('Scriptlet list reset.');
                updateSafeViewUI();
            }
        };
    }

    // --- Heuristics Tab ---
    const heuristicsContent = document.getElementById('cp-tab-heuristics');
    if (heuristicsContent) {
        heuristicsContent.innerHTML = `
            <div class="cp-list-management" style="grid-template-columns: 1fr 1fr;">
                <div class="cp-list-col" style="max-height: none;">
                    <h4>Configurable Heuristics (${config.heuristics.length})</h4>
                    <p style="font-size: 0.8rem;">Selectors blocked by the Mutation Observer. 'always' vs 'aggressive' scope. (User-Zapped rules are 'always')</p>
                    <div id="cp-heuristics-editor" style="max-height: 250px; overflow-y: auto; margin-bottom: 15px;"></div>
                    <div style="display: flex; gap: 10px;">
                        <input id="cp-heur-new-selector" placeholder="CSS Selector (e.g., .ad)" style="flex: 3; background: #111; color: #fff; border: 1px solid #444; padding: 5px;">
                        <select id="cp-heur-new-scope" style="flex: 1; background: #111; color: #fff; border: 1px solid #444; padding: 5px;">
                            <option value="aggressive">Aggressive</option>
                            <option value="always">Always</option>
                        </select>
                        <button id="cp-heur-add" class="cp-button cp-button-blue" style="margin-top: 0;">Add</button>
                    </div>
                    <button id="cp-heur-save" class="cp-button cp-button-blue" style="width: 100%;">Save Heuristics List</button>
                </div>
                <div class="cp-list-col">
                    <h4>Learned Selectors (READ ONLY: ${config.learnedSelectorList.size})</h4>
                    <p style="font-size: 0.8rem;">Selectors automatically learned by the heuristic engine. Active in Aggressive Mode.</p>
                    <textarea class="cp-list-textarea" style="color: #aaa;" readonly>${Array.from(config.learnedSelectorList).join('\n')}</textarea>
                    <button id="cp-list-clear-learned" class="cp-button cp-button-red">Clear Learned List</button>
                </div>
            </div>
        `;
        const renderHeuristics = () => {
            const editor = document.getElementById('cp-heuristics-editor');
            if (!editor) return;
            editor.innerHTML = '';
            config.heuristics.forEach((item, index) => {
                const el = document.createElement('div');
                el.className = 'cp-heur-item';
                const comment = item.comment || '';
                const isZapped = comment.startsWith('User Zapped');
                el.innerHTML = `
                    <div>
                        <code>${item.selector}</code>
                        <small style="display: block;">Scope: <span style="color:${item.scope === 'always' ? (isZapped ? 'var(--cp-blue-light)' : 'var(--cp-red)') : 'var(--cp-orange)'}; font-weight: bold;">${isZapped ? 'ZAPPED (Always)' : item.scope}</span></small>
                        <small style="color: #888; display: block; font-style: italic;">${isZapped ? comment.replace('User Zapped on ', 'on ') : comment}</small>
                    </div>
                    <button class="cp-button cp-button-red cp-heur-remove" data-index="${index}" style="padding: 3px 8px; margin-top: 0;">Remove</button>
                `;
                editor.appendChild(el);
            });
            editor.querySelectorAll('.cp-heur-remove').forEach(btn => {
                btn.onclick = () => {
                    config.heuristics.splice(parseInt(btn.getAttribute('data-index')), 1);
                    renderHeuristics(); // Re-render
                };
            });
        };
        renderHeuristics();
        const btnHeurAdd = document.getElementById('cp-heur-add');
        if (btnHeurAdd) btnHeurAdd.onclick = () => {
            const selectorEl = document.getElementById('cp-heur-new-selector');
            const scopeEl = document.getElementById('cp-heur-new-scope');
            if (selectorEl && scopeEl) {
                const selector = selectorEl.value.trim();
                if (selector) {
                    config.heuristics.push({ selector, scope: scopeEl.value, comment: 'User Added' });
                    selectorEl.value = '';
                    renderHeuristics();
                }
            }
        };
        const btnHeurSave = document.getElementById('cp-heur-save');
        if (btnHeurSave) btnHeurSave.onclick = () => { saveConfig(); logDebug('Heuristics list saved.'); alert('Heuristics saved!'); };
        
        const btnLearnClear = document.getElementById('cp-list-clear-learned');
        if (btnLearnClear) btnLearnClear.onclick = async () => {
            if (await promptConfirmation('Are you sure you want to clear ALL learned selectors?')) {
                config.learnedSelectorList.clear();
                saveConfig(); logDebug('Learned Selector List cleared.');
                updateSafeViewUI();
            }
        };
    }

    // --- Logs Tab ---
    const logsContent = document.getElementById('cp-tab-logs');
    if (logsContent) {
        const filterLogHTML = filterLogs.slice().reverse().map(entry => `<div class="cp-log-entry ${entry.type}">[${entry.time}] [${entry.type}] ${entry.target} (${entry.reason})</div>`).join('');
        const debugLogHTML = logs.slice().reverse().map(log => {
            const type = (log.match(/\[(ERROR|WARN|INFO|DEBUG)\]/) || [])[1] || 'INFO';
            return `<div class="cp-log-entry ${type}" style="color:${type === 'ERROR' ? 'var(--cp-red)' : (type === 'WARN' ? 'var(--cp-orange)' : '#ccc')};">[${log.split(' ')[0]}] ${log.substring(log.indexOf('] ') + 2)}</div>`;
        }).join('');
        logsContent.innerHTML = `
            <div style="display: flex; justify-content: space-between; margin-bottom: 15px;">
                <button id="cp-reset-logs" class="cp-button cp-button-red">Flush All Logs</button>
                <button id="cp-reset-stats" class="cp-button cp-button-red">Reset All Stats</button>
            </div>
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                <div style="max-height: 40vh; overflow-y: auto; background: var(--cp-bg-light); padding: 10px; border-radius: 6px;">
                    <h4 style="margin-top: 0;">Filter (Block/Allow) Log (${filterLogs.length})</h4>
                    ${filterLogHTML || '<p style="font-style: italic;">No filter activity yet.</p>'}
                </div>
                <div style="max-height: 40vh; overflow-y: auto; background: var(--cp-bg-light); padding: 10px; border-radius: 6px;">
                    <h4 style="margin-top: 0;">Debug Console Log (${logs.length})</h4>
                    ${debugLogHTML || '<p style="font-style: italic;">No console activity yet.</p>'}
                </div>
            </div>
        `;
        const btnResetLogs = document.getElementById('cp-reset-logs');
        if (btnResetLogs) btnResetLogs.onclick = resetLogs;
        const btnResetStats = document.getElementById('cp-reset-stats');
        if (btnResetStats) btnResetStats.onclick = resetStats;
    }

    // --- Data Tab ---
    const dataContent = document.getElementById('cp-tab-data');
    if (dataContent) {
        const backups = JSON.parse(GM_getValue(CP_TOKEN + 'backups', '[]'));
        dataContent.innerHTML = `
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px;">
                <div class="cp-list-col" style="max-height: none;">
                    <h4>Import/Export Data (Full State)</h4>
                    <p style="font-size: 0.9rem;">Use this to transfer settings between devices.</p>
                    <button id="cp-export-data" class="cp-button cp-button-blue" style="margin-bottom: 10px;">Export to Clipboard</button>
                    <button id="cp-import-prompt" class="cp-button cp-button-red">Import Data (Overwrite)</button>
                </div>
                <div class="cp-list-col" style="max-height: none;">
                    <h4>Backup Management</h4>
                    <p style="font-size: 0.9rem;">Max 10 stored.</p>
                    <button id="cp-create-backup" class="cp-button cp-button-green" style="margin-bottom: 10px;">Create New Backup Now</button>
                    <div id="cp-backup-list" style="max-height: 150px; overflow-y: auto; padding: 5px 0;">
                        ${backups.map((b, index) => `
                            <div class="cp-setting-item" style="font-size: 0.85rem;">
                                <span>${index + 1}. ${new Date(b.timestamp).toLocaleString()} (v${b.version})</span>
                                <span>
                                    <button class="cp-button cp-button-blue cp-restore-btn" data-index="${index}" style="padding: 3px 8px; margin-right: 5px;">Restore</button>
                                    <button class="cp-button cp-button-red cp-delete-btn" data-index="${index}" style="padding: 3px 8px;">Delete</button>
                                </span>
                            </div>
                        `).join('') || '<p style="font-style: italic;">No backups found.</p>'}
                    </div>
                </div>
            </div>
        `;
        const btnExport = document.getElementById('cp-export-data');
        if (btnExport) btnExport.onclick = exportData;
        const btnImport = document.getElementById('cp-import-prompt');
        if (btnImport) btnImport.onclick = promptImportData;
        const btnBackup = document.getElementById('cp-create-backup');
        if (btnBackup) btnBackup.onclick = createBackup;
        
        document.querySelectorAll('.cp-restore-btn').forEach(btn => {
            btn.onclick = async () => {
                if (await promptConfirmation(`Restore from backup ${parseInt(btn.getAttribute('data-index')) + 1}? This will overwrite settings and reload.`)) {
                    restoreFromBackup(backups[parseInt(btn.getAttribute('data-index'))]);
                }
            };
        });
        document.querySelectorAll('.cp-delete-btn').forEach(btn => {
            btn.onclick = async () => {
                if (await promptConfirmation(`Delete backup ${parseInt(btn.getAttribute('data-index')) + 1}?`)) {
                    const updatedBackups = JSON.parse(GM_getValue(CP_TOKEN + 'backups', '[]')).filter((_, i) => i !== parseInt(btn.getAttribute('data-index')));
                    GM_setValue(CP_TOKEN + 'backups', JSON.stringify(updatedBackups));
                    logDebug(`Backup deleted.`);
                    updateSafeViewUI();
                }
            };
        });
    }
    updateBarStats();
  }

  /**
   * (v40.1) Initializes and displays the SafeView modal UI.
   * This is the full-featured UI builder.
   */
  function showSafeView(initialTab = 'overview') {
    try {
        let modal = document.getElementById('cp-safeview-modal');
        if (modal) {
            modal.style.display = 'flex';
            config.safeViewOpen = true; saveConfig();
            activateTab(initialTab);
            return;
        }
        modal = document.createElement('div');
        modal.id = 'cp-safeview-modal';
        modal.className = 'cp-modal';
        modal.innerHTML = `
            <div class="cp-modal-content">
                <div class="cp-header">
                    <h2>${SCRIPT_NAME} SafeView v${VERSION}</h2>
                    <button id="cp-close-safeview" class="cp-close-btn">&times;</button>
                </div>
                <div class="cp-tabs">
                    <button class="cp-tab-btn" data-tab="overview">Overview</button>
                    <button class="cp-tab-btn" data-tab="stats">Statistics</button>
                    <button class="cp-tab-btn" data-tab="relief">Domain Relief</button>
                    <button class="cp-tab-btn" data-tab="lists">Domain Lists</button>
                    <button class="cp-tab-btn" data-tab="trackers">Trackers & Scriptlets</button>
                    <button class="cp-tab-btn" data-tab="heuristics">Heuristics</button>
                    <button class="cp-tab-btn" data-tab="logs">Logs & History</button>
                    <button class="cp-tab-btn" data-tab="data">Import/Export</button>
                </div>
                <div id="cp-tab-content-container" class="cp-tab-content">
                    <div id="cp-tab-overview" class="cp-tab-pane"></div>
                    <div id="cp-tab-stats" class="cp-tab-pane" style="display:none;"></div>
                    <div id="cp-tab-relief" class="cp-tab-pane" style="display:none;"></div>
                    <div id="cp-tab-lists" class="cp-tab-pane" style="display:none;"></div>
                    <div id="cp-tab-trackers" class="cp-tab-pane" style="display:none;"></div>
                    <div id="cp-tab-heuristics" class="cp-tab-pane" style="display:none;"></div>
                    <div id="cp-tab-logs" class="cp-tab-pane" style="display:none;"></div>
                    <div id="cp-tab-data" class="cp-tab-pane" style="display:none;"></div>
                </div>
            </div>
        `;
        document.documentElement.appendChild(modal); // Patched: append to documentElement
        document.getElementById('cp-close-safeview').onclick = hideSafeView;
        document.querySelectorAll('.cp-tab-btn').forEach(button => {
            button.onclick = (e) => activateTab(e.target.getAttribute('data-tab'));
        });
        modal.style.display = 'flex';
        config.safeViewOpen = true; saveConfig();
        activateTab(initialTab);
    } catch (e) { logDebug(`showSafeView error: ${e.message}`, 'warn'); }
  }

  /**
   * Hides the SafeView modal.
   */
  function hideSafeView() {
    try {
        const modal = document.getElementById('cp-safeview-modal');
        if (modal) {
            modal.style.display = 'none';
            config.safeViewOpen = false; saveConfig();
        }
    } catch (e) { logDebug(`hideSafeView error: ${e.message}`, 'warn'); }
  }

  /**
   * Handles tab switching logic.
   */
  function activateTab(tabName) {
    try {
        document.querySelectorAll('.cp-tab-pane').forEach(pane => pane.style.display = 'none');
        document.querySelectorAll('.cp-tab-btn').forEach(btn => btn.classList.remove('active'));
        const activePane = document.getElementById(`cp-tab-${tabName}`);
        if (activePane) activePane.style.display = 'block';
        const activeButton = document.querySelector(`.cp-tab-btn[data-tab="${tabName}"]`);
        if (activeButton) activeButton.classList.add('active');
        updateSafeViewUI();
    } catch (e) { logDebug(`activateTab error: ${e.message}`, 'warn'); }
  }

  /*************** Status Bar (Patched) ***************/
  let statusBar;
  function updateBarStats() {
    try {
      if (!config.showBarStats) {
          if (statusBar) statusBar.remove(); statusBar = null;
          return;
      }
      if (!statusBar && document.body) {
          statusBar = document.createElement('div');
          statusBar.id = 'cp-status-bar';
          statusBar.style.cssText = `
              position: fixed; bottom: 0; left: 0; width: 100%; padding: 5px 15px;
              background-color: rgba(0, 0, 0, 0.85); color: #f0f0f0; font-size: 10px;
              font-family: sans-serif; z-index: 99999; display: flex;
              justify-content: space-between; align-items: center;
              border-top: 1px solid #333; cursor: pointer;
          `;
          statusBar.onclick = () => showSafeView('stats');
          document.body.appendChild(statusBar);
      }
      if (!statusBar) return; // Body not ready

      // (v40.1.1) Patched relief check
      const isRelieved = Array.from(reliefDomains.keys()).some(k => k === DOMAIN || DOMAIN.endsWith('.' + k));
      const currentRelief = reliefDomains.get(DOMAIN);
      const modeColor = config.blockingMode === 'Aggressive' ? 'var(--cp-orange)' : 'var(--cp-primary)';
      const modeText = config.blockingMode === 'Aggressive' ? 'AGGRESSIVE' : 'STEALTH';
      let reliefIndicator = '';
      if (isRelieved) {
          const expiryText = currentRelief && currentRelief.expiry === null ? 'PERMANENT' : (currentRelief ? `${Math.max(0, Math.floor((currentRelief.expiry - Date.now()) / 60000))}m` : '');
          reliefIndicator = ` | <span style="color:var(--cp-red); font-weight: bold;">RELIEF: ${expiryText}</span>`;
      }

      statusBar.innerHTML = `
          <span style="font-weight: bold; margin-right: 15px;">CleanPage v${VERSION} (${config.enabled ? 'ACTIVE' : 'DISABLED'})</span>
          <span style="flex-grow: 1;">
              MODE: <span style="color:${modeColor}; font-weight: bold;">${modeText}</span>
              ${reliefIndicator}
          </span>
          <span style="margin-left: 15px;">
              TOTAL BLOCKED: <span style="color:var(--cp-red); font-weight: bold;">${stats.blockedTotal}</span>
              (i:${stats.blockedIframes} | f:${stats.blockedFetches} | m:${stats.blockedMutations} | p:${stats.popupBlocked})
          </span>
      `;
    } catch (e) { logDebug(`updateBarStats error: ${e.message}`, 'warn'); }
  }

  /*************** GM Menu & Initialization (Patched) ***************/

  /**
   * Registers all GreaseMonkey menu commands.
   * (v40.1.1: Patched relief check)
   */
  function registerMenuCommands() {
    try {
      GM_registerMenuCommand(`[${SCRIPT_NAME}] Open SafeView`, () => showSafeView('overview'));
      GM_registerMenuCommand(`[${SCRIPT_NAME}] ⚡ Activate Element Zapper`, activateZapper); // v40
      GM_registerMenuCommand(`[${SCRIPT_NAME}] ${config.enabled ? 'Disable Script' : 'Enable Script'}`, toggleScriptEnabled);
      GM_registerMenuCommand(`[${SCRIPT_NAME}] ${config.blockingMode} Mode: Toggle to ${config.blockingMode === 'Aggressive' ? 'Stealth' : 'Aggressive'}`, toggleBlockingMode);
      
      const isRelieved = Array.from(reliefDomains.keys()).some(k => k === DOMAIN || DOMAIN.endsWith('.' + k));
      GM_registerMenuCommand(`[${SCRIPT_NAME}] ${isRelieved ? 'Clear Relief on' : 'Set Timed Relief (30m) on'} ${DOMAIN}`, () => toggleDomainRelief(isRelieved ? 0 : 30));
      GM_registerMenuCommand(`[${SCRIPT_NAME}] Pause/Resume Blocking`, togglePause);
      GM_registerMenuCommand(`[${SCRIPT_NAME}] Import/Overwrite Data`, promptImportData);
      GM_registerMenuCommand(`[${SCRIPT_NAME}] Force Update External Lists`, () => updateExternalBlocklists(true)); // v40.1
    } catch (e) { logDebug(`registerMenuCommands error: ${e.message}`, 'warn'); }
  }

  /**
   * (v40.1.1) Main function to initialize all modules.
   * Patched: Better DOM-ready handling, delayed list update.
   */
  function initScript() {
    // 1. Load config and state first
    loadConfig();
    loadFetchedData(); // v40.1: Load state AND fetched list cache
    
    // 2. Register GM commands
    registerMenuCommands();

    // 3. Start VITAL Privacy Interceptors (run-at document-start)
    if (config.useStorageIsolation) initStorageIsolation();
    if (config.useAntiFingerprinting) applyAntiFingerprinting();
    if (config.useWebRTCLeakProtection) applyWebRTCLeakProtection();
    
    // 4. Start Network Interceptors
    fetchInterceptor();
    wrapXHR();
    
    // 5. Start Popup Blocker (Wrapper only)
    popupNewTabBlocker();

    // 6. If disabled, stop here
    if (!config.enabled) {
        logDebug('Script is currently DISABLED via configuration.', 'warn');
        if (document.readyState !== 'loading') updateBarStats();
        else document.addEventListener('DOMContentLoaded', updateBarStats);
        return;
    }

    // 7. Initialize DOM/iFrame blocking (wait for DOM if not fully loaded)
    const onDOMLoaded = () => {
        // Init main observer
        initMutationObserver(document.documentElement, false);
        // Run initial scans on main document
        iframeBlockerScan(document);
        // --- PATCH 4 (Performance) ---
        // Run initial anchor scan
        handleAnchorTags(document); 
        
        if (config.useShadowDOMScanner) {
            scanForShadowRoots(document.documentElement, 0); // Patched: pass depth
        }
        // Init UI
        updateBarStats();
        if (config.safeViewOpen) {
            showSafeView('overview');
        }
        // Start periodic scans
        setInterval(() => { try { iframeBlockerScan(document); } catch (e) {} }, 7000); // Patched: wider interval
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onDOMLoaded);
    } else {
      onDOMLoaded();
    }

    // 8. Expose Debug API
    if (window) {
      try {
        window[DEBUG_API_ID] = {
          version: VERSION,
          config, reliefDomains, stats, filterLogs, logs, fetchedBlockList,
          flushLogs: resetLogs,
          openSafeView: () => showSafeView('overview'),
          togglePause: togglePause,
          forceListUpdate: () => updateExternalBlocklists(true)
        };
        logDebug('Debug API exposed');
      } catch (e) {}
    }

    const reliefStatus = Array.from(reliefDomains.keys()).some(k => k === DOMAIN || DOMAIN.endsWith('.' + k)) ? 'Active' : 'None';
    logDebug(`CleanPage Initialized (v${VERSION}). Mode: ${config.blockingMode}. Relief: ${reliefStatus}`, 'info');

    // 9. Start automatic list update (will check timestamp)
    setTimeout(() => updateExternalBlocklists(false), 2000); // Patched: run after a short delay
  }

  // Execute the main initialization function
  try { initScript(); } catch (e) { logDebug(`Initialization failed: ${e.message}`, 'error'); }
})();
