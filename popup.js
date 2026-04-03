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
const liveStats = document.getElementById('liveStats');
const liveWords = document.getElementById('liveWords');
const liveSpeaker = document.getElementById('liveSpeaker');
const captionWarning = document.getElementById('captionWarning');

// End Meeting Section Elements
const endMeetingSection = document.getElementById('endMeetingSection');
const recipientNameInput = document.getElementById('recipientName');
const transcriptPreview = document.getElementById('transcriptPreview');
const transcriptDuration = document.getElementById('transcriptDuration');
const transcriptWords = document.getElementById('transcriptWords');
const downloadBtn = document.getElementById('downloadBtn');
const sendStatus = document.getElementById('sendStatus');

// State
let isRecording = false;
let currentPlatform = null;
let currentTabId = null;
let hasCompletedTranscription = false;
let transcriptionData = null;
let statsPollingInterval = null;

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

  // Enable download button
  downloadBtn.disabled = !transcriptionData.text.trim();
}

// Hide the end meeting section
function hideEndMeetingSection() {
  endMeetingSection.classList.remove('visible');
  hasCompletedTranscription = false;
  transcriptionData = null;
  sendStatus.textContent = '';
  sendStatus.className = 'send-status';
  recipientNameInput.value = '';
  downloadBtn.disabled = true;
}

// Polling de stats mientras graba
function startStatsPolling() {
  stopStatsPolling();
  liveStats.style.display = 'block';
  captionWarning.style.display = 'none';
  liveWords.textContent = '📝 0 palabras';
  liveSpeaker.textContent = '';

  statsPollingInterval = setInterval(async () => {
    if (!currentTabId) return;
    try {
      const stats = await chrome.tabs.sendMessage(currentTabId, { action: 'GET_STATS' });
      if (stats) {
        liveWords.textContent = `📝 ${stats.wordCount.toLocaleString()} palabras`;
        liveSpeaker.textContent = stats.lastSpeaker ? `🎤 ${stats.lastSpeaker}` : '';
      }
    } catch {
      // content script no disponible aún
    }
  }, 2000);
}

function stopStatsPolling() {
  if (statsPollingInterval) {
    clearInterval(statsPollingInterval);
    statsPollingInterval = null;
  }
  liveStats.style.display = 'none';
  captionWarning.style.display = 'none';
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
    statusText.textContent = 'Grabando...';
    toggleBtn.textContent = 'Detener';
    toggleBtn.className = 'btn btn-stop';
    startStatsPolling();
  } else if (currentPlatform) {
    statusIndicator.className = 'status-indicator ready';
    statusText.textContent = 'Listo para transcribir';
    toggleBtn.textContent = 'Iniciar transcripción';
    toggleBtn.className = 'btn btn-start';
    stopStatsPolling();
  } else {
    statusIndicator.className = 'status-indicator inactive';
    statusText.textContent = 'Abre una reunión para empezar';
    toggleBtn.textContent = 'Iniciar transcripción';
    toggleBtn.className = 'btn btn-start';
    stopStatsPolling();
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

// ============================================================
// DOCUMENT DOWNLOAD - genera HTML formateado como Gemini Docs
// ============================================================

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Paleta de colores por speaker (hasta 8 speakers distintos)
const SPEAKER_COLORS = [
  '#1a73e8', '#0b8043', '#d93025', '#e37400',
  '#7627bb', '#007b83', '#c2185b', '#5d4037'
];

// ── Deduplicación y limpieza de líneas antes de renderizar ────────────────────
function cleanLines(rawLines) {
  // Parsear líneas con formato [HH:MM:SS] Speaker: Texto
  const parsed = [];
  for (const line of rawLines) {
    const m = line.match(/^\[([^\]]+)\] ([^:]+): (.+)$/);
    if (m) {
      parsed.push({ time: m[1], speaker: m[2].trim(), text: m[3].trim(), raw: line });
    } else {
      parsed.push({ time: null, speaker: null, text: line.trim(), raw: line });
    }
  }

  const result = [];
  for (const entry of parsed) {
    if (!entry.text) continue;
    const textLow = entry.text.toLowerCase();

    // Comparar contra las últimas 80 entradas limpias
    const lookback = result.slice(-80);
    const isDuplicate = lookback.some(prev => {
      const prevLow = prev.text.toLowerCase();
      if (prevLow === textLow) return true;
      // Solo descartar si la entrada anterior YA CONTIENE este texto (ya fue capturado en algo más largo).
      // NO descartar si este texto extiende la anterior — eso es contenido nuevo.
      if (prevLow.includes(textLow)) return true;
      // Similitud Sørensen-Dice rápida
      if (textLow.length < 15 || prevLow.length < 15) return false;
      const set = new Set();
      for (let i = 0; i < prevLow.length - 1; i++) set.add(prevLow.slice(i, i + 2));
      let inter = 0;
      for (let i = 0; i < textLow.length - 1; i++) { if (set.has(textLow.slice(i, i + 2))) inter++; }
      return (2 * inter) / (prevLow.length + textLow.length - 2) > 0.80;
    });

    if (!isDuplicate) result.push(entry);
  }
  return result;
}

function generateHTMLDocument(data, recipientName) {
  const startDate = new Date(data.startTime);
  const dateStr = startDate.toLocaleDateString('es-ES', { day: '2-digit', month: 'long', year: 'numeric' });
  const timeStr = startDate.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

  const durationMs = data.endTime - data.startTime;
  const minutes = Math.floor(durationMs / 60000);
  const seconds = Math.floor((durationMs % 60000) / 1000);

  const rawLines = data.text.split('\n').filter(l => l.trim());
  const lines = cleanLines(rawLines).map(e => e.raw);
  const wordCount = lines.join(' ').trim().split(/\s+/).filter(w => w).length;

  // Asignar color a cada speaker
  const speakerColors = {};
  let colorIdx = 0;
  const speakers = new Set();
  for (const line of lines) {
    const m = line.match(/^\[[^\]]+\] ([^:]+):/);
    if (m) speakers.add(m[1].trim());
  }
  for (const sp of speakers) {
    speakerColors[sp] = SPEAKER_COLORS[colorIdx++ % SPEAKER_COLORS.length];
  }

  // ── Parsear entradas ────────────────────────────────────────────────────────
  function timeToSec(t) {
    const p = t.split(':').map(Number);
    return p[0] * 3600 + p[1] * 60 + (p[2] || 0);
  }

  const entries = [];
  for (const line of lines) {
    const m = line.match(/^\[([^\]]+)\] ([^:]+): (.+)$/);
    if (m) {
      entries.push({ time: m[1], sec: timeToSec(m[1]), speaker: m[2].trim(), text: m[3].trim() });
    }
  }

  // ── Agrupar en bloques: mismo speaker + dentro de 10 segundos = mismo párrafo
  // Si pasan más de 10s entre frases del mismo speaker, se abre un nuevo bloque.
  const MERGE_GAP = 10; // segundos
  const blocks = [];
  let cur = null;

  for (const e of entries) {
    if (!cur || cur.speaker !== e.speaker || (e.sec - cur.lastSec) > MERGE_GAP) {
      if (cur) blocks.push(cur);
      cur = { speaker: e.speaker, startTime: e.time, lastSec: e.sec, parts: [e.text] };
    } else {
      cur.parts.push(e.text);
      cur.lastSec = e.sec;
    }
  }
  if (cur) blocks.push(cur);

  // ── Renderizar bloques como párrafos limpios ────────────────────────────────
  let transcriptHtml = '';
  for (const block of blocks) {
    const color = speakerColors[block.speaker] || '#555';

    // Deduplicar partes progresivas: si una parte extiende la anterior, usar solo la más larga.
    const dedupedParts = [];
    for (const part of block.parts) {
      const partLow = part.toLowerCase().trim();
      if (dedupedParts.length === 0) {
        dedupedParts.push(part);
        continue;
      }
      const prevLow = dedupedParts[dedupedParts.length - 1].toLowerCase().trim();
      // Si la parte anterior está contenida en esta, reemplazar
      if (partLow.includes(prevLow)) {
        dedupedParts[dedupedParts.length - 1] = part;
      // Si esta parte está contenida en la anterior, descartar
      } else if (prevLow.includes(partLow)) {
        // no agregar
      } else {
        // Son diferentes, conservar ambas
        dedupedParts.push(part);
      }
    }

    const paragraph = dedupedParts.join(' ').replace(/\s+/g, ' ').trim();
    transcriptHtml += `<div class="block">
      <div class="speaker" style="color:${color}">${escapeHtml(block.speaker)} <span class="time">${escapeHtml(block.startTime)}</span></div>
      <div class="lines">${escapeHtml(paragraph)}</div>
    </div>`;
  }

  // Lista de participantes para el encabezado
  const participantList = [...speakers].map(sp => {
    const color = speakerColors[sp] || '#555';
    return `<span class="pill" style="background:${color}20;color:${color};border:1px solid ${color}40">${escapeHtml(sp)}</span>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<title>Transcripción – ${escapeHtml(recipientName)} – ${dateStr}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Segoe UI',Arial,sans-serif;background:#f8f9fa;color:#202124;padding:32px 16px}
  .card{background:#fff;max-width:780px;margin:0 auto;border-radius:12px;box-shadow:0 1px 6px rgba(0,0,0,.12);overflow:hidden}
  .card-header{background:#1a73e8;color:#fff;padding:28px 32px}
  .card-header .logo{height:36px;margin-bottom:8px;display:block}
  .card-header h1{font-size:22px;font-weight:600;margin-bottom:4px}
  .card-header .sub{font-size:14px;opacity:.85}
  .meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;padding:20px 32px;border-bottom:1px solid #e8eaed}
  .meta-item{display:flex;flex-direction:column;gap:2px}
  .meta-label{font-size:11px;color:#80868b;text-transform:uppercase;letter-spacing:.5px}
  .meta-value{font-size:14px;font-weight:500;color:#202124}
  .participants{padding:16px 32px;border-bottom:1px solid #e8eaed;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
  .participants-label{font-size:12px;color:#80868b;margin-right:4px}
  .pill{padding:4px 10px;border-radius:20px;font-size:12px;font-weight:500}
  .transcript{padding:24px 32px}
  .block{margin-bottom:20px}
  .speaker{font-size:13px;font-weight:700;margin-bottom:4px}
  .lines{font-size:15px;line-height:1.7;color:#3c4043}
  .time{font-size:11px;color:#9aa0a6;font-family:monospace}
  .raw{font-size:14px;color:#5f6368;margin-bottom:12px}
  .footer{padding:16px 32px;border-top:1px solid #e8eaed;font-size:12px;color:#9aa0a6;text-align:center}
  @media print{body{background:#fff;padding:0}.card{box-shadow:none;border-radius:0}}
</style>
</head>
<body>
<div class="card">
  <div class="card-header">
    <img src="https://yaweb.co/Logoyaweb.png" alt="Yaweb" class="logo">
    <h1>Transcripción de Reunión</h1>
    <div class="sub">Con: ${escapeHtml(recipientName || 'Sin especificar')}</div>
  </div>
  <div class="meta">
    <div class="meta-item"><span class="meta-label">Fecha</span><span class="meta-value">${dateStr}</span></div>
    <div class="meta-item"><span class="meta-label">Hora</span><span class="meta-value">${timeStr}</span></div>
    <div class="meta-item"><span class="meta-label">Duración</span><span class="meta-value">${minutes}m ${seconds}s</span></div>
    <div class="meta-item"><span class="meta-label">Palabras</span><span class="meta-value">${wordCount.toLocaleString()}</span></div>
  </div>
  ${participantList ? `<div class="participants"><span class="participants-label">Participantes:</span>${participantList}</div>` : ''}
  <div class="transcript">${transcriptHtml || '<p class="raw">No se capturó ninguna transcripción</p>'}</div>
  <div class="footer">Generado por Meeting Transcriber · ${new Date().toLocaleString('es-ES')}</div>
</div>
</body>
</html>`;
}

function downloadTranscript() {
  if (!transcriptionData?.text) return;

  const recipientName = recipientNameInput.value.trim() || 'reunion';
  const html = generateHTMLDocument(transcriptionData, recipientName);
  // Base64 data URL — única forma confiable de forzar UTF-8 en archivos HTML descargados
  // desde una extensión de Chrome (Blob URL ignora charset en archivos locales)
  const encoded = btoa(unescape(encodeURIComponent(html)));
  const url = `data:text/html;charset=utf-8;base64,${encoded}`;

  const date = new Date(transcriptionData.startTime).toISOString().slice(0, 10);
  const safeName = recipientName.replace(/[^a-z0-9áéíóúñ\s]/gi, '_').slice(0, 40).trim();
  const filename = `transcripcion_${safeName}_${date}.html`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  sendStatus.textContent = 'Documento descargado';
  sendStatus.className = 'send-status success';
  setTimeout(() => {
    sendStatus.textContent = '';
    sendStatus.className = 'send-status';
  }, 3000);
}

// Event Listeners
toggleBtn.addEventListener('click', toggleTranscription);
downloadBtn.addEventListener('click', downloadTranscript);

// Listen for state changes from background and content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'TRANSCRIPTION_STOPPED') {
    isRecording = false;
    updateUI();
    checkForCompletedTranscription();
  }

  if (message.action === 'TRANSCRIPTION_READY') {
    checkForCompletedTranscription();
  }

  if (message.action === 'CAPTION_WARNING') {
    captionWarning.style.display = 'block';
  }

  sendResponse({ received: true });
});
