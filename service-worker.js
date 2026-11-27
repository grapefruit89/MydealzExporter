// MyDealz AI Exporter – Background Service Worker (MV3)
'use strict';

// Zustand in chrome.storage.session (überlebt SW-Suspension nach 30s)
// Transport für das In-Page-Dashboard: kein chrome.tabs.create mehr — die
// Analyse läuft als <dialog>-Overlay auf der Deal-Seite (content/content.js).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'STORE_EXPORT') {
    chrome.storage.session.set({ pendingExport: msg.payload })
      .then(() => sendResponse({ ok: true }))
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true; // async sendResponse
  }

  if (msg.type === 'GET_EXPORT_DATA') {
    chrome.storage.session.get('pendingExport')
      .then(res => {
        sendResponse(res.pendingExport || null);
      })
      .catch(() => {
        sendResponse(null);
      });
    return true; // async sendResponse
  }
});
