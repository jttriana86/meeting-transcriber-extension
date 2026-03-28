// Meeting Transcriber - Background Service Worker

// ============================================================================
// EMAILJS CONFIGURATION
// ============================================================================
// To configure EmailJS:
// 1. Create account at https://www.emailjs.com/
// 2. Add an email service (Gmail, Outlook, etc.) in EmailJS dashboard
// 3. Create an email template with variables: {{to_name}}, {{subject}}, {{message}}
// 4. Copy your Service ID, Template ID, and Public Key below
// 5. Set your recipient email address
// ============================================================================
const EMAILJS_CONFIG = {
  SERVICE_ID: 'service_iyqaeni',      // e.g., 'service_abc123'
  TEMPLATE_ID: 'template_o63jghc',    // e.g., 'template_xyz789'
  PUBLIC_KEY: 'hjpyrO1C_u2GiQGms',      // e.g., 'AbCdEfGhIjKlMnOp'
  RECIPIENT_EMAIL: 'jttriana86@gmail.com'  // Your fixed email address
};

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

    case 'SEND_TRANSCRIPTION':
      handleSendTranscription(message.data)
        .then(result => sendResponse(result))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true; // Keep channel open for async response

    default:
      sendResponse({ success: false, error: 'Unknown action' });
  }

  return true; // Keep message channel open for async response
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

  // Update badge to show recording
  chrome.action.setBadgeText({ text: 'REC', tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#ef4444', tabId });
}

// Stop transcription for a tab
async function handleStopTranscription(tabId) {
  console.log(`[Background] Stopping transcription for tab ${tabId}`);

  const data = activeTranscriptions.get(tabId);
  console.log(`[Background] Active transcription data:`, data);

  if (data) {
    data.status = 'completed';
    data.endTime = Date.now();

    console.log(`[Background] Processing completed transcription with ${data.transcript.length} entries`);
    await processCompletedTranscription(tabId, data);

    activeTranscriptions.delete(tabId);
  } else {
    console.log(`[Background] No active transcription found for tab ${tabId}, creating empty one`);
    // Create empty transcription data so popup still shows the section
    await processCompletedTranscription(tabId, {
      platform: 'unknown',
      startTime: Date.now() - 60000, // 1 minute ago
      endTime: Date.now(),
      transcript: [],
      status: 'completed'
    });
  }

  // Clear badge
  chrome.action.setBadgeText({ text: '', tabId }).catch(() => {});

  // Update storage
  await chrome.storage.local.set({ isRecording: false, recordingTabId: null });

  // Notify popup
  chrome.runtime.sendMessage({ action: 'TRANSCRIPTION_STOPPED', tabId }).catch(() => {
    console.log('[Background] Popup not open, message not delivered');
  });
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

// Process completed transcription
async function processCompletedTranscription(tabId, data) {
  const duration = data.endTime - data.startTime;
  const minutes = Math.floor(duration / 60000);

  console.log(`Transcription completed: ${minutes} minutes, ${data.transcript.length} entries`);

  // Format transcript as text
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

  console.log(`[Background] Transcription text length: ${transcriptionText.length}`);

  // Store in format expected by popup for email sending
  await chrome.storage.local.set({
    completedTranscription: true,
    transcriptionText: transcriptionText,
    transcriptionStartTime: data.startTime,
    transcriptionEndTime: data.endTime,
    transcriptionPlatform: data.platform,
    // Also keep legacy format for backwards compatibility
    lastTranscription: {
      platform: data.platform,
      duration: minutes,
      entryCount: data.transcript.length,
      transcript: data.transcript
    },
    lastTranscriptionTime: Date.now()
  });

  // Notify popup that transcription is ready
  chrome.runtime.sendMessage({ action: 'TRANSCRIPTION_READY', tabId });
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

// Check if URL is a supported meeting platform
function checkIsMeetingUrl(url, platform) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.includes(platform);
  } catch {
    return false;
  }
}

// ============================================================================
// EMAIL SENDING FUNCTIONS
// ============================================================================

/**
 * Handle the SEND_TRANSCRIPTION message from popup
 * @param {Object} data - Transcription data from popup
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function handleSendTranscription(data) {
  const { recipientName, transcriptionText, startTime, endTime, platform } = data;

  // Validate required data
  if (!transcriptionText || !transcriptionText.trim()) {
    return { success: false, error: 'No hay transcripción para enviar' };
  }

  // Check EmailJS configuration
  if (EMAILJS_CONFIG.SERVICE_ID === 'YOUR_SERVICE_ID' ||
    EMAILJS_CONFIG.TEMPLATE_ID === 'YOUR_TEMPLATE_ID' ||
    EMAILJS_CONFIG.PUBLIC_KEY === 'YOUR_PUBLIC_KEY') {
    return {
      success: false,
      error: 'EmailJS no está configurado. Edita EMAILJS_CONFIG en background.js'
    };
  }

  try {
    await sendTranscriptionEmail(recipientName, transcriptionText, {
      startTime,
      endTime,
      platform
    });
    return { success: true };
  } catch (error) {
    console.error('Error sending email:', error);
    return { success: false, error: error.message || 'Error al enviar el email' };
  }
}

/**
 * Send transcription email via EmailJS
 * @param {string} recipientName - Name of the person/company from the meeting
 * @param {string} transcriptionText - Full transcription text
 * @param {Object} metadata - Meeting metadata (startTime, endTime, platform)
 * @returns {Promise<void>}
 */
async function sendTranscriptionEmail(recipientName, transcriptionText, metadata) {
  const { startTime, endTime, platform } = metadata;

  // Format date for subject
  const meetingDate = new Date(startTime);
  const dateStr = meetingDate.toLocaleDateString('es-ES', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const timeStr = meetingDate.toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit'
  });

  // Calculate duration
  const durationMs = endTime - startTime;
  const durationMinutes = Math.floor(durationMs / 60000);
  const durationSeconds = Math.floor((durationMs % 60000) / 1000);
  const durationStr = `${durationMinutes}m ${durationSeconds}s`;

  // Format email subject
  const subject = `Reunión con ${recipientName || 'Sin especificar'} - ${dateStr}`;

  // Format email body with transcription
  const formattedBody = formatTranscriptionBody(transcriptionText, {
    recipientName,
    date: dateStr,
    time: timeStr,
    duration: durationStr,
    platform: platform || 'Desconocida'
  });

  // Send via EmailJS REST API
  const response = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      service_id: EMAILJS_CONFIG.SERVICE_ID,
      template_id: EMAILJS_CONFIG.TEMPLATE_ID,
      user_id: EMAILJS_CONFIG.PUBLIC_KEY,
      template_params: {
        to_email: EMAILJS_CONFIG.RECIPIENT_EMAIL,
        to_name: 'Meeting Transcriber User',
        subject: subject,
        message: formattedBody,
        // Additional template variables you might want to use
        recipient_name: recipientName || 'Sin especificar',
        meeting_date: dateStr,
        meeting_time: timeStr,
        meeting_duration: durationStr,
        meeting_platform: platform || 'Desconocida'
      }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`EmailJS error: ${response.status} - ${errorText}`);
  }

  console.log('Email sent successfully');
}

/**
 * Format the transcription body with metadata footer
 * @param {string} transcriptionText - Raw transcription text
 * @param {Object} metadata - Formatted metadata
 * @returns {string} Formatted email body
 */
function formatTranscriptionBody(transcriptionText, metadata) {
  const { recipientName, date, time, duration, platform } = metadata;

  const header = `
═══════════════════════════════════════════════════════════
TRANSCRIPCIÓN DE REUNIÓN
═══════════════════════════════════════════════════════════

📅 Fecha: ${date}
🕐 Hora: ${time}
👤 Con: ${recipientName || 'Sin especificar'}
💻 Plataforma: ${platform}
⏱️ Duración: ${duration}

═══════════════════════════════════════════════════════════
TRANSCRIPCIÓN
═══════════════════════════════════════════════════════════

`;

  const footer = `

═══════════════════════════════════════════════════════════
FIN DE LA TRANSCRIPCIÓN
═══════════════════════════════════════════════════════════

📌 Este email fue generado automáticamente por Meeting Transcriber
`;

  return header + transcriptionText.trim() + footer;
}
