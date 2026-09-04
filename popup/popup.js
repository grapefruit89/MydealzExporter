const keyInput = document.getElementById('apiKey');
const saveBtn = document.getElementById('save');
const savedMsg = document.getElementById('saved');

// Gespeicherten Key laden
chrome.storage.local.get(['geminiApiKey'], (r) => {
    if (r.geminiApiKey) keyInput.value = r.geminiApiKey;
});

saveBtn.onclick = () => {
    const key = keyInput.value.trim();
    chrome.storage.local.set({ geminiApiKey: key }, () => {
        savedMsg.style.display = 'block';
        setTimeout(() => savedMsg.style.display = 'none', 2000);
    });
};
