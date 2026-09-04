// MyDealz AI Exporter – Background Service Worker
'use strict';

// Temporärer Speicher für Export-Daten (bis Dashboard sie abruft)
let pendingExport = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'OPEN_DASHBOARD') {
        pendingExport = msg.payload;
        // Dashboard als neuer Tab öffnen
        chrome.tabs.create({ url: chrome.runtime.getURL('ui/dashboard.html') });
        sendResponse({ ok: true });
    }

    if (msg.type === 'GET_EXPORT_DATA') {
        sendResponse(pendingExport);
        pendingExport = null; // einmal lesen, dann weg
    }

    return true; // async sendResponse
});
