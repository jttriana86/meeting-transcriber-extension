// Meeting Transcriber - Background Service Worker

// State management
let activeTranscriptions = new Map(); // tabId -> transcription data

// Initialize extension
chrome.runtime.onInstalled.addListener(() => {
  console.log('Meeting Transcriber installed');
  chrome.storage.local.set({ isRecording: false, recordingTabId: null });
});

// Handle messages from popup and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId || sender.tab?.id;

  switch (message.action) {
    case 'START_TRANSCRIPTION':
      handleStartTranscription(tabId, message.platform);
      sendResponse({ success: true });
      break;

    case 'STOP_TRANSCRIPTION':
      handleStopTranscription(tabId);
      sendResponse({ success: true });
      break;

    case 'TRANSCRIPTION_DATA':
      handleTranscriptionData(tabId, message.data);
      sendResponse({ success: true });
      break;

    case 'GET_STATE':
      const state = activeTranscriptions.get(tabId);
      sendResponse({ isRecording: !!state, data: state });
      break;

    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }

  return true;
});

// Start transcription for a tab
function handleStartTranscription(tabId, platform) {
  console.log(`Starting transcription for tab ${tabId} on ${platform}`);

  activeTranscriptions.set(tabId, {
    platform,
    startTime: Date.now(),
    transcript: [],
    status: 'recording'
  });

  chrome.action.setBadgeText({ text: 'REC', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId });
}

// Stop transcription for a tab
async function handleStopTranscription(tabId) {
  console.log(`[Background] Stopping transcription for tab ${tabId}`);

  const data = activeTranscriptions.get(tabId);

  // SIEMPRE: primero decirle al content script que pare y vacíe su buffer.
  // Luego esperar brevemente para que el flush síncrono termine.
  // Esto evita la race condition: sin este paso, GET_TRANSCRIPT llega antes
  // de que el content script haya vaciado el buffer → se pierden las últimas frases.
  try {
    await chrome.tabs.sendMessage(tabId, { action: 'STOP_TRANSCRIPTION' });
    await new Promise(resolve => setTimeout(resolve, 400));
  } catch (e) {
    // content script no disponible (tab cerrado, etc.)
  }

  let recovered = null;

  // Fuente 1: content script (más completo — buffer ya vaciado en el paso anterior)
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'GET_TRANSCRIPT' });
    if (response?.success && response.entries?.length > 0) {
      console.log(`[Background] Got ${response.entries.length} entries from content script`);
      recovered = {
        platform: response.platform || (data?.platform ?? 'unknown'),
        startTime: response.entries[0]?.timestamp || Date.now() - 60000,
        endTime: Date.now(),
        transcript: response.entries
      };
    }
  } catch (e) {
    console.log('[Background] Content script unreachable, trying storage...');
  }

  // Fuente 2: storage (content script guarda ahí continuamente)
  if (!recovered) {
    try {
      const stored = await chrome.storage.local.get(['currentMeetingId']);
      if (stored.currentMeetingId) {
        const key = `transcript_${stored.currentMeetingId}`;
        const transcriptData = await chrome.storage.local.get([key]);
        const entries = transcriptData[key];
        if (entries?.length > 0) {
          console.log(`[Background] Recovered ${entries.length} entries from storage`);
          const platform = stored.currentMeetingId.split('_')[0] || 'unknown';
          recovered = {
            platform,
            startTime: entries[0]?.timestamp || Date.now() - 60000,
            endTime: Date.now(),
            transcript: entries
          };
        }
      }
    } catch (e) {
      console.error('[Background] Error reading from storage:', e);
    }
  }

  // Fuente 3: datos en memoria del SW (fallback si content script no responde)
  if (!recovered && data && data.transcript.length > 0) {
    console.log(`[Background] Using in-memory data: ${data.transcript.length} entries`);
    data.endTime = Date.now();
    recovered = data;
  }

  await processCompletedTranscription(tabId, recovered || {
    platform: data?.platform ?? 'unknown',
    startTime: Date.now() - 60000,
    endTime: Date.now(),
    transcript: []
  });

  if (data) activeTranscriptions.delete(tabId);

  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});
  await chrome.storage.local.set({ isRecording: false, recordingTabId: null });

  chrome.runtime.sendMessage({ action: 'TRANSCRIPTION_STOPPED', tabId }).catch(() => {});
}

// Handle incoming transcription data from content script
function handleTranscriptionData(tabId, data) {
  const transcription = activeTranscriptions.get(tabId);
  if (transcription) {
    transcription.transcript.push({
      timestamp: Date.now(),
      text: data.text,
      speaker: data.speaker || 'Unknown'
    });
  }
}

// Process completed transcription and save to storage for popup
async function processCompletedTranscription(tabId, data) {
  const duration = data.endTime - data.startTime;
  const minutes = Math.floor(duration / 60000);

  console.log(`Transcription completed: ${minutes} minutes, ${data.transcript.length} entries`);

  let transcriptionText = '';
  if (data.transcript && data.transcript.length > 0) {
    transcriptionText = data.transcript.map(entry => {
      const time = new Date(entry.timestamp).toLocaleTimeString('es-ES', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      return `[${time}] ${entry.speaker}: ${entry.text}`;
    }).join('\n');
  } else {
    transcriptionText = '(No se capturaron subtítulos. Asegúrate de activar los subtítulos en la reunión.)';
  }

  await chrome.storage.local.set({
    completedTranscription: true,
    transcriptionText: transcriptionText,
    transcriptionStartTime: data.startTime,
    transcriptionEndTime: data.endTime,
    transcriptionPlatform: data.platform
  });

  chrome.runtime.sendMessage({ action: 'TRANSCRIPTION_READY', tabId }).catch(() => {});
}

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeTranscriptions.has(tabId)) {
    handleStopTranscription(tabId);
  }
});

// Handle tab URL changes (leaving meeting page)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && activeTranscriptions.has(tabId)) {
    const data = activeTranscriptions.get(tabId);
    const isMeetingUrl = checkIsMeetingUrl(changeInfo.url, data.platform);
    if (!isMeetingUrl) {
      console.log(`Tab ${tabId} navigated away from meeting`);
      handleStopTranscription(tabId);
    }
  }
});

function checkIsMeetingUrl(url, platform) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes(platform);
  } catch {
    return false;
  }
}
