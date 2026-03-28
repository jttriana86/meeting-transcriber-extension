// Meeting Transcriber - Popup Controller

const PLATFORMS = {
  'meet.google.com': { name: 'Google Meet', color: '#00897b' },
  'zoom.us': { name: 'Zoom', color: '#2d8cff' },
  'teams.microsoft.com': { name: 'Microsoft Teams', color: '#6264a7' },
  'teams.live.com': { name: 'Microsoft Teams', color: '#6264a7' }
};

// DOM Elements
const toggleBtn = document.getElementById('toggleBtn');
const statusIndicator = document.getElementById('statusIndicator');
const statusText = document.getElementById('statusText');
const platformBadge = document.getElementById('platformBadge');

// End Meeting Section Elements
const endMeetingSection = document.getElementById('endMeetingSection');
const recipientNameInput = document.getElementById('recipientName');
const transcriptPreview = document.getElementById('transcriptPreview');
const transcriptDuration = document.getElementById('transcriptDuration');
const transcriptWords = document.getElementById('transcriptWords');
const sendBtn = document.getElementById('sendBtn');
const sendStatus = document.getElementById('sendStatus');

// State
let isRecording = false;
let currentPlatform = null;
let currentTabId = null;
let hasCompletedTranscription = false;
let transcriptionData = null;

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  await detectPlatform();
  await loadState();
  await checkForCompletedTranscription();
  updateUI();
});

// Detect if current tab is a supported meeting platform
async function detectPlatform() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.url) {
      currentPlatform = null;
      return;
    }

    currentTabId = tab.id;
    const url = new URL(tab.url);

    for (const [domain, info] of Object.entries(PLATFORMS)) {
      if (url.hostname.includes(domain)) {
        currentPlatform = { domain, ...info };
        return;
      }
    }

    currentPlatform = null;
  } catch (error) {
    console.error('Error detecting platform:', error);
    currentPlatform = null;
  }
}

// Load transcription state from storage
async function loadState() {
  try {
    const result = await chrome.storage.local.get(['isRecording', 'recordingTabId']);
    isRecording = result.isRecording && result.recordingTabId === currentTabId;
  } catch (error) {
    console.error('Error loading state:', error);
    isRecording = false;
  }
}

// Save transcription state to storage
async function saveState() {
  try {
    await chrome.storage.local.set({
      isRecording,
      recordingTabId: isRecording ? currentTabId : null
    });
  } catch (error) {
    console.error('Error saving state:', error);
  }
}

// Check if there's a completed transcription ready to send
async function checkForCompletedTranscription() {
  console.log('[Popup] Checking for completed transcription...');
  try {
    const result = await chrome.storage.local.get([
      'completedTranscription',
      'transcriptionText',
      'transcriptionStartTime',
      'transcriptionEndTime'
    ]);

    console.log('[Popup] Storage result:', result);

    if (result.completedTranscription) {
      hasCompletedTranscription = true;
      transcriptionData = {
        text: result.transcriptionText || '(No se capturaron subtítulos)',
        startTime: result.transcriptionStartTime || Date.now(),
        endTime: result.transcriptionEndTime || Date.now()
      };
      console.log('[Popup] Showing end meeting section with data:', transcriptionData);
      showEndMeetingSection();
    } else {
      console.log('[Popup] No completed transcription found in storage');
    }
  } catch (error) {
    console.error('Error checking for completed transcription:', error);
  }
}

// Show the end meeting section with transcript preview
function showEndMeetingSection() {
  if (!transcriptionData) return;

  endMeetingSection.classList.add('visible');

  // Calculate duration
  if (transcriptionData.startTime && transcriptionData.endTime) {
    const durationMs = transcriptionData.endTime - transcriptionData.startTime;
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    transcriptDuration.textContent = `Duración: ${minutes}m ${seconds}s`;
  }

  // Count words
  const wordCount = transcriptionData.text.trim().split(/\s+/).filter(w => w).length;
  transcriptWords.textContent = `Palabras: ${wordCount}`;

  // Show preview (truncated if too long)
  if (transcriptionData.text.trim()) {
    transcriptPreview.classList.remove('empty');
    const previewText = transcriptionData.text.length > 500
      ? transcriptionData.text.substring(0, 500) + '...'
      : transcriptionData.text;
    transcriptPreview.textContent = previewText;
  } else {
    transcriptPreview.classList.add('empty');
    transcriptPreview.textContent = 'No se capturó ninguna transcripción';
  }

  // Enable send button
  sendBtn.disabled = !transcriptionData.text.trim();
}

// Hide the end meeting section
function hideEndMeetingSection() {
  endMeetingSection.classList.remove('visible');
  hasCompletedTranscription = false;
  transcriptionData = null;
  sendStatus.textContent = '';
  sendStatus.className = 'send-status';
  recipientNameInput.value = '';
}

// Send transcription
async function sendTranscription() {
  if (!transcriptionData?.text) return;

  const recipientName = recipientNameInput.value.trim() || 'Sin especificar';

  // Update UI to sending state
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<span class="spinner"></span>Enviando...';
  sendBtn.classList.add('sending');
  sendStatus.textContent = 'Enviando transcripción...';
  sendStatus.className = 'send-status sending';

  try {
    // Send message to background script to handle email
    const response = await chrome.runtime.sendMessage({
      action: 'SEND_TRANSCRIPTION',
      data: {
        recipientName,
        transcriptionText: transcriptionData.text,
        startTime: transcriptionData.startTime,
        endTime: transcriptionData.endTime,
        platform: currentPlatform?.name || 'Unknown'
      }
    });

    if (response?.success) {
      // Success state
      sendBtn.innerHTML = '✓ Enviado';
      sendBtn.classList.remove('sending');
      sendBtn.classList.add('success');
      sendStatus.textContent = 'Transcripción enviada correctamente';
      sendStatus.className = 'send-status success';

      // Clear the completed transcription from storage
      await chrome.storage.local.remove([
        'completedTranscription',
        'transcriptionText',
        'transcriptionStartTime',
        'transcriptionEndTime'
      ]);

      // Hide section after delay
      setTimeout(() => {
        hideEndMeetingSection();
      }, 2000);
    } else {
      throw new Error(response?.error || 'Error al enviar');
    }
  } catch (error) {
    console.error('Error sending transcription:', error);

    // Error state
    sendBtn.innerHTML = 'Reintentar envío';
    sendBtn.disabled = false;
    sendBtn.classList.remove('sending');
    sendBtn.classList.add('error');
    sendStatus.textContent = `Error: ${error.message}`;
    sendStatus.className = 'send-status error';

    // Reset error state after delay
    setTimeout(() => {
      sendBtn.classList.remove('error');
    }, 3000);
  }
}

// Update UI based on current state
function updateUI() {
  // Update platform badge
  if (currentPlatform) {
    platformBadge.textContent = currentPlatform.name;
    platformBadge.classList.remove('none');
    platformBadge.style.background = currentPlatform.color + '20';
    platformBadge.style.color = currentPlatform.color;
    toggleBtn.disabled = false;
  } else {
    platformBadge.textContent = 'No meeting detected';
    platformBadge.classList.add('none');
    platformBadge.style.background = '';
    platformBadge.style.color = '';
    toggleBtn.disabled = true;
  }

  // Update status and button based on recording state
  if (isRecording) {
    statusIndicator.className = 'status-indicator recording';
    statusText.textContent = 'Recording in progress...';
    toggleBtn.textContent = 'Stop Transcription';
    toggleBtn.className = 'btn btn-stop';
  } else if (currentPlatform) {
    statusIndicator.className = 'status-indicator ready';
    statusText.textContent = 'Ready to transcribe';
    toggleBtn.textContent = 'Start Transcription';
    toggleBtn.className = 'btn btn-start';
  } else {
    statusIndicator.className = 'status-indicator inactive';
    statusText.textContent = 'Open a meeting to start';
    toggleBtn.textContent = 'Start Transcription';
    toggleBtn.className = 'btn btn-start';
  }
}

// Toggle transcription on/off
async function toggleTranscription() {
  isRecording = !isRecording;
  await saveState();

  // Send message to background script
  try {
    await chrome.runtime.sendMessage({
      action: isRecording ? 'START_TRANSCRIPTION' : 'STOP_TRANSCRIPTION',
      tabId: currentTabId,
      platform: currentPlatform?.domain
    });
  } catch (error) {
    console.error('Error sending message to background:', error);
  }

  // Send message to content script (only if on a meeting page)
  // First check if content script is available by pinging it
  if (currentPlatform && currentTabId) {
    chrome.tabs.sendMessage(currentTabId, {
      action: isRecording ? 'START_TRANSCRIPTION' : 'STOP_TRANSCRIPTION'
    }).catch(() => {
      // Silently ignore - content script may not be loaded
    });
  }

  // If stopping, check for completed transcription after a short delay
  if (!isRecording) {
    setTimeout(() => {
      checkForCompletedTranscription();
    }, 500);
  }

  updateUI();
}

// Event Listeners
toggleBtn.addEventListener('click', toggleTranscription);
sendBtn.addEventListener('click', sendTranscription);

// Listen for state changes from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'TRANSCRIPTION_STOPPED') {
    isRecording = false;
    updateUI();
    // Check for completed transcription after stopping
    checkForCompletedTranscription();
  }

  if (message.action === 'TRANSCRIPTION_READY') {
    // Transcription data is ready to be sent
    checkForCompletedTranscription();
  }

  sendResponse({ received: true });
});
