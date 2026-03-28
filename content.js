// Meeting Transcriber - Content Script
// Injected into Meet, Zoom, and Teams pages

(function() {
  'use strict';

  // State
  let isRecording = false;
  let platform = null;

  // ============================================
  // GOOGLE MEET CAPTION CAPTURE
  // ============================================

  const MeetCaptionCapture = {
    observer: null,
    pollInterval: null,
    transcript: [],
    lastCaptionText: '',
    lastCaptionTime: 0,
    currentBuffer: new Map(), // speaker -> {text, timestamp, timeoutId}

    // Selectores DOM para captions de Meet (actualizados marzo 2025)
    SELECTORS: {
      // Contenedor principal de captions
      captionContainer: '[data-is-muted] ~ div, [jsname="dsyhDe"], .a4cQT',
      // Texto de caption individual
      captionText: '[data-message-text], .CNusmb, .TBMuR span',
      // Nombre del speaker
      speakerName: '[data-sender-name], .zs7s8d, .NWpY1d',
      // Contenedor de captions activo (indica que CC está ON)
      captionsActive: '[jsname="Ypp7Cf"], .iOzk7, [data-panel-id="10"]'
    },

    // Iniciar captura
    start() {
      console.log('[Meet Capture] Starting caption capture...');

      this.transcript = [];
      this.lastCaptionText = '';
      this.currentBuffer.clear();

      // Cargar transcripción existente de esta sesión
      this.loadExistingTranscript();

      // Intentar encontrar captions inmediatamente
      this.findAndObserveCaptions();

      // Polling como fallback si captions no están visibles aún
      this.pollInterval = setInterval(() => {
        if (!this.observer) {
          this.findAndObserveCaptions();
        }
      }, 2000);
    },

    // Buscar contenedor de captions y observar
    findAndObserveCaptions() {
      // Buscar cualquier contenedor de captions
      const captionContainer = this.findCaptionContainer();

      if (captionContainer) {
        console.log('[Meet Capture] Caption container found, setting up observer');
        this.setupObserver(captionContainer);
        return true;
      }

      // Buscar en todo el documento como fallback
      this.setupDocumentObserver();
      return false;
    },

    // Encontrar el contenedor de captions
    findCaptionContainer() {
      // Estrategia 1: Buscar por selectores conocidos
      for (const selector of Object.values(this.SELECTORS)) {
        const element = document.querySelector(selector);
        if (element && this.looksLikeCaptionContainer(element)) {
          return element;
        }
      }

      // Estrategia 2: Buscar divs con texto que parezcan captions
      const allDivs = document.querySelectorAll('div[jsname], div[data-message-text]');
      for (const div of allDivs) {
        if (this.looksLikeCaptionContainer(div)) {
          return div.parentElement || div;
        }
      }

      return null;
    },

    // Verificar si un elemento parece contener captions
    looksLikeCaptionContainer(element) {
      if (!element) return false;

      // Verificar si tiene texto y está en la parte inferior de la pantalla
      const rect = element.getBoundingClientRect();
      const isLowerHalf = rect.top > window.innerHeight / 2;
      const hasText = element.textContent?.trim().length > 0;

      return isLowerHalf && hasText;
    },

    // Configurar MutationObserver en el contenedor de captions
    setupObserver(container) {
      if (this.observer) {
        this.observer.disconnect();
      }

      this.observer = new MutationObserver((mutations) => {
        this.processMutations(mutations);
      });

      this.observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        characterDataOldValue: true
      });

      // Limpiar polling ya que tenemos observer activo
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      console.log('[Meet Capture] MutationObserver active on caption container');
    },

    // Observer de documento completo como fallback
    setupDocumentObserver() {
      if (this.observer) return;

      this.observer = new MutationObserver((mutations) => {
        // Buscar si alguna mutación contiene captions
        for (const mutation of mutations) {
          if (mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                const captionContainer = this.findCaptionContainer();
                if (captionContainer) {
                  this.observer.disconnect();
                  this.observer = null;
                  this.setupObserver(captionContainer);
                  return;
                }
              }
            }
          }
        }

        // También procesar mutaciones de texto
        this.processMutations(mutations);
      });

      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });

      console.log('[Meet Capture] Document observer active (waiting for captions)');
    },

    // Procesar mutaciones del DOM
    processMutations(mutations) {
      for (const mutation of mutations) {
        // Cambios de texto
        if (mutation.type === 'characterData') {
          const text = mutation.target.textContent?.trim();
          if (text && text !== mutation.oldValue?.trim()) {
            this.handleCaptionUpdate(text, this.extractSpeaker(mutation.target));
          }
        }

        // Nodos añadidos
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            this.extractCaptionsFromNode(node);
          }
        }
      }
    },

    // Extraer captions de un nodo
    extractCaptionsFromNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text && text.length > 0) {
          this.handleCaptionUpdate(text, this.extractSpeaker(node));
        }
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      // Buscar texto de caption
      const captionElements = node.querySelectorAll
        ? node.querySelectorAll(this.SELECTORS.captionText)
        : [];

      for (const elem of captionElements) {
        const text = elem.textContent?.trim();
        if (text) {
          this.handleCaptionUpdate(text, this.extractSpeaker(elem));
        }
      }

      // También verificar el texto directo del nodo
      if (node.textContent?.trim() && !node.querySelector) {
        this.handleCaptionUpdate(node.textContent.trim(), 'Unknown');
      }
    },

    // Extraer nombre del speaker del contexto del nodo
    extractSpeaker(node) {
      if (!node) return 'Unknown';

      // Subir en el árbol DOM buscando el nombre
      let current = node.parentElement;
      let maxDepth = 10;

      while (current && maxDepth > 0) {
        // Buscar elemento con nombre de speaker
        const speakerElem = current.querySelector(this.SELECTORS.speakerName);
        if (speakerElem) {
          const name = speakerElem.textContent?.trim();
          if (name && name.length < 100) { // Sanity check
            return name;
          }
        }

        // Verificar atributos data-sender-name
        const senderName = current.getAttribute?.('data-sender-name');
        if (senderName) {
          return senderName;
        }

        current = current.parentElement;
        maxDepth--;
      }

      return 'Unknown';
    },

    // Manejar actualización de caption (con debounce y deduplicación)
    handleCaptionUpdate(text, speaker) {
      if (!text || text.length < 1) return;

      const now = Date.now();

      // Google Meet actualiza el texto mientras se habla
      // Debounce: esperar a que el texto se estabilice
      const bufferKey = speaker || 'default';
      const existing = this.currentBuffer.get(bufferKey);

      // Limpiar timeout anterior si existe
      if (existing?.timeoutId) {
        clearTimeout(existing.timeoutId);
      }

      // Verificar si es texto nuevo o actualización
      if (existing && this.isTextUpdate(existing.text, text)) {
        // Es una actualización del mismo caption, actualizar buffer
        this.currentBuffer.set(bufferKey, {
          text: text,
          timestamp: existing.timestamp, // Mantener timestamp original
          timeoutId: setTimeout(() => this.flushBuffer(bufferKey), 1500)
        });
      } else if (!existing || !this.isDuplicate(existing.text, text)) {
        // Es texto nuevo
        // Flush el buffer anterior primero si existe
        if (existing) {
          this.flushBuffer(bufferKey);
        }

        this.currentBuffer.set(bufferKey, {
          text: text,
          timestamp: now,
          speaker: speaker,
          timeoutId: setTimeout(() => this.flushBuffer(bufferKey), 1500)
        });
      }
    },

    // Verificar si es una actualización del mismo texto
    isTextUpdate(oldText, newText) {
      if (!oldText || !newText) return false;

      // El nuevo texto contiene el viejo (Meet añade palabras)
      if (newText.startsWith(oldText) || newText.includes(oldText)) {
        return true;
      }

      // El viejo texto es prefijo del nuevo
      if (oldText.length < newText.length && newText.startsWith(oldText.slice(0, -3))) {
        return true;
      }

      return false;
    },

    // Verificar duplicados
    isDuplicate(existingText, newText) {
      if (!existingText || !newText) return false;

      // Exactamente igual
      if (existingText === newText) return true;

      // Diferencia menor (errores de corrección de Meet)
      const similarity = this.calculateSimilarity(existingText, newText);
      return similarity > 0.85;
    },

    // Calcular similitud entre dos strings (Sørensen-Dice)
    calculateSimilarity(str1, str2) {
      if (str1 === str2) return 1;
      if (str1.length < 2 || str2.length < 2) return 0;

      const bigrams1 = new Set();
      for (let i = 0; i < str1.length - 1; i++) {
        bigrams1.add(str1.substring(i, i + 2).toLowerCase());
      }

      let intersection = 0;
      for (let i = 0; i < str2.length - 1; i++) {
        if (bigrams1.has(str2.substring(i, i + 2).toLowerCase())) {
          intersection++;
        }
      }

      return (2 * intersection) / (str1.length + str2.length - 2);
    },

    // Flush buffer y guardar entrada
    flushBuffer(bufferKey) {
      const entry = this.currentBuffer.get(bufferKey);
      if (!entry || !entry.text) return;

      // Verificar que no sea duplicado de la última entrada
      const lastEntry = this.transcript[this.transcript.length - 1];
      if (lastEntry && this.isDuplicate(lastEntry.text, entry.text)) {
        this.currentBuffer.delete(bufferKey);
        return;
      }

      const transcriptEntry = {
        timestamp: entry.timestamp,
        speaker: entry.speaker || 'Unknown',
        text: entry.text,
        isoTime: new Date(entry.timestamp).toISOString()
      };

      this.transcript.push(transcriptEntry);
      this.currentBuffer.delete(bufferKey);

      console.log(`[Meet Capture] "${entry.speaker}": "${entry.text}"`);

      // Guardar en storage
      this.saveTranscript();

      // Notificar al background script
      sendTranscriptionData(entry.text, entry.speaker);
    },

    // Guardar transcripción en storage
    async saveTranscript() {
      try {
        const meetingId = this.getMeetingId();
        const storageKey = `transcript_${meetingId}`;

        await chrome.storage.local.set({
          [storageKey]: this.transcript,
          currentMeetingId: meetingId,
          lastUpdated: Date.now()
        });
      } catch (error) {
        console.error('[Meet Capture] Error saving transcript:', error);
      }
    },

    // Cargar transcripción existente
    async loadExistingTranscript() {
      try {
        const meetingId = this.getMeetingId();
        const storageKey = `transcript_${meetingId}`;

        const result = await chrome.storage.local.get([storageKey]);
        if (result[storageKey] && Array.isArray(result[storageKey])) {
          this.transcript = result[storageKey];
          console.log(`[Meet Capture] Loaded ${this.transcript.length} existing entries`);
        }
      } catch (error) {
        console.error('[Meet Capture] Error loading transcript:', error);
      }
    },

    // Obtener ID único de la reunión desde la URL
    getMeetingId() {
      const url = window.location.href;
      const match = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
      return match ? match[1] : `meet_${Date.now()}`;
    },

    // Exportar transcripción completa
    exportTranscript() {
      // Flush todos los buffers pendientes
      for (const [key] of this.currentBuffer) {
        this.flushBuffer(key);
      }

      return {
        meetingId: this.getMeetingId(),
        platform: 'google-meet',
        startTime: this.transcript[0]?.isoTime || new Date().toISOString(),
        endTime: new Date().toISOString(),
        entries: [...this.transcript],
        totalEntries: this.transcript.length,

        // Formato texto plano
        asText() {
          return this.entries.map(e =>
            `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.speaker}: ${e.text}`
          ).join('\n');
        },

        // Formato Markdown
        asMarkdown() {
          let md = `# Meeting Transcript\n\n`;
          md += `**Meeting ID:** ${this.meetingId}\n`;
          md += `**Date:** ${new Date(this.startTime).toLocaleDateString()}\n`;
          md += `**Duration:** ${this.startTime} - ${this.endTime}\n\n`;
          md += `---\n\n`;

          let currentSpeaker = '';
          for (const entry of this.entries) {
            if (entry.speaker !== currentSpeaker) {
              currentSpeaker = entry.speaker;
              md += `\n**${currentSpeaker}** *(${new Date(entry.timestamp).toLocaleTimeString()})*\n`;
            }
            md += `${entry.text} `;
          }

          return md;
        }
      };
    },

    // Detener captura
    stop() {
      console.log('[Meet Capture] Stopping capture...');

      // Flush buffers pendientes
      for (const [key] of this.currentBuffer) {
        this.flushBuffer(key);
      }

      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }

      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      // Guardar transcripción final
      this.saveTranscript();

      const exported = this.exportTranscript();
      console.log(`[Meet Capture] Captured ${exported.totalEntries} entries`);

      return exported;
    },

    // Obtener estado actual
    getStatus() {
      return {
        isActive: this.observer !== null,
        entriesCount: this.transcript.length,
        lastEntry: this.transcript[this.transcript.length - 1] || null,
        meetingId: this.getMeetingId()
      };
    }
  };

  // Detect current platform
  function detectPlatform() {
    const hostname = window.location.hostname;

    if (hostname.includes('meet.google.com')) {
      return 'meet';
    } else if (hostname.includes('zoom.us')) {
      return 'zoom';
    } else if (hostname.includes('teams.microsoft.com') || hostname.includes('teams.live.com')) {
      return 'teams';
    }

    return null;
  }

  // Initialize
  function init() {
    platform = detectPlatform();

    if (!platform) {
      console.log('[Meeting Transcriber] Not a supported meeting platform');
      return;
    }

    console.log(`[Meeting Transcriber] Detected platform: ${platform}`);

    // Listen for messages from popup/background
    chrome.runtime.onMessage.addListener(handleMessage);

    // Check if we should resume recording (page refresh scenario)
    checkResumeState();
  }

  // Helper para obtener el capture activo según plataforma
  function getActiveCapture() {
    switch (platform) {
      case 'meet':
        return MeetCaptionCapture;
      case 'zoom':
        return ZoomCaptionCapture;
      case 'teams':
        return TeamsCaptionCapture;
      default:
        return null;
    }
  }

  // Handle messages from popup/background
  function handleMessage(message, _sender, sendResponse) {
    const capture = getActiveCapture();

    switch (message.action) {
      case 'START_TRANSCRIPTION':
        startTranscription();
        sendResponse({ success: true });
        break;

      case 'STOP_TRANSCRIPTION':
        stopTranscription();
        sendResponse({ success: true });
        break;

      case 'GET_STATUS':
        sendResponse({
          isRecording,
          platform,
          captureStatus: capture ? capture.getStatus() : null
        });
        break;

      case 'EXPORT_TRANSCRIPT':
        if (capture) {
          const exported = capture.exportTranscript();
          sendResponse({ success: true, transcript: exported });
        } else {
          sendResponse({ success: false, error: 'No active capture for this platform' });
        }
        break;

      case 'GET_TRANSCRIPT':
        if (capture) {
          sendResponse({
            success: true,
            entries: capture.transcript,
            meetingId: capture.getMeetingId(),
            platform: platform
          });
        } else {
          sendResponse({ success: false, error: 'No active capture for this platform' });
        }
        break;

      default:
        sendResponse({ success: false, error: 'Unknown action' });
    }

    return true;
  }

  // Check if we should resume recording
  async function checkResumeState() {
    try {
      const result = await chrome.storage.local.get(['isRecording', 'recordingTabId']);
      // Note: We can't easily check tabId from content script,
      // so we just check if recording was active
      if (result.isRecording) {
        console.log('[Meeting Transcriber] Resuming transcription...');
        // Don't auto-resume to avoid confusion, let user restart manually
      }
    } catch (error) {
      console.error('[Meeting Transcriber] Error checking resume state:', error);
    }
  }

  // Start transcription
  function startTranscription() {
    if (isRecording) {
      console.log('[Meeting Transcriber] Already recording');
      return;
    }

    isRecording = true;
    console.log('[Meeting Transcriber] Starting transcription...');

    // Platform-specific initialization
    switch (platform) {
      case 'meet':
        initMeetCapture();
        break;
      case 'zoom':
        initZoomCapture();
        break;
      case 'teams':
        initTeamsCapture();
        break;
    }
  }

  // Stop transcription
  function stopTranscription() {
    if (!isRecording) {
      console.log('[Meeting Transcriber] Not currently recording');
      return;
    }

    isRecording = false;
    console.log('[Meeting Transcriber] Stopping transcription...');

    // Clean up observers and listeners
    cleanupCapture();
  }

  // ============================================
  // ZOOM WEB CAPTION CAPTURE
  // ============================================

  const ZoomCaptionCapture = {
    observer: null,
    pollInterval: null,
    transcript: [],
    lastCaptionText: '',
    lastCaptionTime: 0,
    currentBuffer: new Map(), // speaker -> {text, timestamp, timeoutId}
    participantMap: new Map(), // avatar/id -> name mapping

    // Selectores DOM para captions de Zoom Web
    SELECTORS: {
      // Contenedor principal de subtítulos (ID único de Zoom)
      captionContainer: '#live-transcription-subtitle',
      // Selectores alternativos con wildcards
      captionContainerAlt: '[class*="live-transcription-subtitle"], [class*="live-transcription"]',
      // Item individual de caption
      captionItem: '.live-transcription-subtitle__item, [class*="subtitle__item"]',
      // Contenedor del texto de cada caption
      captionText: '[class*="subtitle-text"], [class*="caption-text"]',
      // Speaker avatar/name en cada línea de caption
      speakerAvatar: '[class*="subtitle-avatar"], [class*="speaker-avatar"]',
      speakerName: '[class*="subtitle-name"], [class*="speaker-name"]',
      // Panel de participantes para mapeo de nombres
      participantsPanel: '.participants-ul, [class*="participants-list"]',
      participantItem: '.participants-item__item-layout, [class*="participant-item"]',
      participantName: '.participants-item__display-name, [class*="display-name"]',
      participantAvatar: '.participants-item__avatar, [class*="avatar"]'
    },

    // Iniciar captura
    start() {
      console.log('[Zoom Capture] Starting caption capture...');

      this.transcript = [];
      this.lastCaptionText = '';
      this.currentBuffer.clear();
      this.participantMap.clear();

      // Cargar transcripción existente
      this.loadExistingTranscript();

      // Construir mapeo de participantes
      this.buildParticipantMap();

      // Intentar encontrar captions inmediatamente
      this.findAndObserveCaptions();

      // Polling como fallback
      this.pollInterval = setInterval(() => {
        if (!this.observer) {
          this.findAndObserveCaptions();
        }
        // Actualizar mapeo de participantes periódicamente
        this.buildParticipantMap();
      }, 3000);
    },

    // Construir mapeo de avatar -> nombre de participante
    buildParticipantMap() {
      try {
        const participantItems = document.querySelectorAll(this.SELECTORS.participantItem);

        for (const item of participantItems) {
          const nameElem = item.querySelector(this.SELECTORS.participantName);
          const avatarElem = item.querySelector(this.SELECTORS.participantAvatar);

          if (nameElem && avatarElem) {
            const name = nameElem.textContent?.trim();
            // Usar src de imagen o texto inicial como key
            let key = '';
            if (avatarElem.tagName === 'IMG') {
              key = avatarElem.src;
            } else {
              key = avatarElem.textContent?.trim() || '';
            }

            if (name && key) {
              this.participantMap.set(key, name);
            }
          }
        }
      } catch (error) {
        // Panel de participantes puede no estar abierto
      }
    },

    // Buscar contenedor de captions y observar
    findAndObserveCaptions() {
      // Buscar por ID principal
      let captionContainer = document.querySelector(this.SELECTORS.captionContainer);

      // Fallback a selectores alternativos
      if (!captionContainer) {
        captionContainer = document.querySelector(this.SELECTORS.captionContainerAlt);
      }

      // Buscar cualquier elemento con clase que contenga 'live-transcription'
      if (!captionContainer) {
        const allElements = document.querySelectorAll('[class*="live-transcription"]');
        for (const elem of allElements) {
          if (elem.textContent?.trim().length > 0) {
            captionContainer = elem;
            break;
          }
        }
      }

      if (captionContainer) {
        console.log('[Zoom Capture] Caption container found, setting up observer');
        this.setupObserver(captionContainer);
        return true;
      }

      // Observer de documento como fallback
      this.setupDocumentObserver();
      return false;
    },

    // Configurar MutationObserver en el contenedor
    setupObserver(container) {
      if (this.observer) {
        this.observer.disconnect();
      }

      this.observer = new MutationObserver((mutations) => {
        this.processMutations(mutations);
      });

      this.observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        characterDataOldValue: true
      });

      // Limpiar polling
      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      console.log('[Zoom Capture] MutationObserver active');

      // Procesar contenido existente
      this.processExistingContent(container);
    },

    // Observer de documento completo como fallback
    setupDocumentObserver() {
      if (this.observer) return;

      this.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                // Verificar si es un contenedor de captions
                if (node.id === 'live-transcription-subtitle' ||
                    node.className?.includes?.('live-transcription')) {
                  this.observer.disconnect();
                  this.observer = null;
                  this.setupObserver(node);
                  return;
                }

                // Buscar dentro del nodo añadido
                const captionContainer = node.querySelector?.(this.SELECTORS.captionContainer) ||
                                        node.querySelector?.(this.SELECTORS.captionContainerAlt);
                if (captionContainer) {
                  this.observer.disconnect();
                  this.observer = null;
                  this.setupObserver(captionContainer);
                  return;
                }
              }
            }
          }
        }

        // Procesar cambios de texto en captions existentes
        this.processMutations(mutations);
      });

      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });

      console.log('[Zoom Capture] Document observer active (waiting for captions)');
    },

    // Procesar contenido existente del contenedor
    processExistingContent(container) {
      const text = container.innerText?.trim();
      if (text) {
        this.handleCaptionUpdate(text, this.extractSpeakerFromContainer(container));
      }
    },

    // Procesar mutaciones del DOM
    processMutations(mutations) {
      for (const mutation of mutations) {
        // Cambios de texto
        if (mutation.type === 'characterData') {
          const text = mutation.target.textContent?.trim();
          if (text && text !== mutation.oldValue?.trim()) {
            const speaker = this.extractSpeakerFromNode(mutation.target);
            this.handleCaptionUpdate(text, speaker);
          }
        }

        // Nodos añadidos
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            this.extractCaptionsFromNode(node);
          }
        }
      }
    },

    // Extraer captions de un nodo
    extractCaptionsFromNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text && text.length > 0) {
          this.handleCaptionUpdate(text, this.extractSpeakerFromNode(node));
        }
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      // Verificar si el nodo tiene innerText significativo
      const text = node.innerText?.trim();
      if (text && text.length > 1) {
        this.handleCaptionUpdate(text, this.extractSpeakerFromNode(node));
      }
    },

    // Extraer speaker del contenedor de captions
    extractSpeakerFromContainer(container) {
      // Zoom puede mostrar múltiples speakers, buscar el activo
      const speakerElem = container.querySelector(this.SELECTORS.speakerName);
      if (speakerElem) {
        return speakerElem.textContent?.trim() || 'Unknown';
      }

      // Intentar con avatar
      const avatarElem = container.querySelector(this.SELECTORS.speakerAvatar);
      if (avatarElem) {
        const key = avatarElem.tagName === 'IMG' ? avatarElem.src : avatarElem.textContent?.trim();
        if (key && this.participantMap.has(key)) {
          return this.participantMap.get(key);
        }
      }

      return 'Unknown';
    },

    // Extraer speaker del contexto de un nodo
    extractSpeakerFromNode(node) {
      if (!node) return 'Unknown';

      let current = node.parentElement;
      let maxDepth = 10;

      while (current && maxDepth > 0) {
        // Buscar nombre de speaker
        const speakerElem = current.querySelector?.(this.SELECTORS.speakerName);
        if (speakerElem) {
          const name = speakerElem.textContent?.trim();
          if (name && name.length < 100) {
            return name;
          }
        }

        // Buscar avatar para mapeo
        const avatarElem = current.querySelector?.(this.SELECTORS.speakerAvatar);
        if (avatarElem) {
          const key = avatarElem.tagName === 'IMG' ? avatarElem.src : avatarElem.textContent?.trim();
          if (key && this.participantMap.has(key)) {
            return this.participantMap.get(key);
          }
        }

        current = current.parentElement;
        maxDepth--;
      }

      return 'Unknown';
    },

    // Manejar actualización de caption (con debounce y deduplicación)
    handleCaptionUpdate(text, speaker) {
      if (!text || text.length < 1) return;

      const now = Date.now();
      const bufferKey = speaker || 'default';
      const existing = this.currentBuffer.get(bufferKey);

      if (existing?.timeoutId) {
        clearTimeout(existing.timeoutId);
      }

      // Verificar si es actualización del mismo caption
      if (existing && this.isTextUpdate(existing.text, text)) {
        this.currentBuffer.set(bufferKey, {
          text: text,
          timestamp: existing.timestamp,
          speaker: speaker,
          timeoutId: setTimeout(() => this.flushBuffer(bufferKey), 1500)
        });
      } else if (!existing || !this.isDuplicate(existing.text, text)) {
        // Texto nuevo
        if (existing) {
          this.flushBuffer(bufferKey);
        }

        this.currentBuffer.set(bufferKey, {
          text: text,
          timestamp: now,
          speaker: speaker,
          timeoutId: setTimeout(() => this.flushBuffer(bufferKey), 1500)
        });
      }
    },

    // Verificar si es actualización del mismo texto
    isTextUpdate(oldText, newText) {
      if (!oldText || !newText) return false;
      if (newText.startsWith(oldText) || newText.includes(oldText)) return true;
      if (oldText.length < newText.length && newText.startsWith(oldText.slice(0, -3))) return true;
      return false;
    },

    // Verificar duplicados con Sørensen-Dice
    isDuplicate(existingText, newText) {
      if (!existingText || !newText) return false;
      if (existingText === newText) return true;
      return this.calculateSimilarity(existingText, newText) > 0.85;
    },

    // Calcular similitud Sørensen-Dice
    calculateSimilarity(str1, str2) {
      if (str1 === str2) return 1;
      if (str1.length < 2 || str2.length < 2) return 0;

      const bigrams1 = new Set();
      for (let i = 0; i < str1.length - 1; i++) {
        bigrams1.add(str1.substring(i, i + 2).toLowerCase());
      }

      let intersection = 0;
      for (let i = 0; i < str2.length - 1; i++) {
        if (bigrams1.has(str2.substring(i, i + 2).toLowerCase())) {
          intersection++;
        }
      }

      return (2 * intersection) / (str1.length + str2.length - 2);
    },

    // Flush buffer y guardar entrada
    flushBuffer(bufferKey) {
      const entry = this.currentBuffer.get(bufferKey);
      if (!entry || !entry.text) return;

      // Verificar que no sea duplicado de la última entrada
      const lastEntry = this.transcript[this.transcript.length - 1];
      if (lastEntry && this.isDuplicate(lastEntry.text, entry.text)) {
        this.currentBuffer.delete(bufferKey);
        return;
      }

      const transcriptEntry = {
        timestamp: entry.timestamp,
        speaker: entry.speaker || 'Unknown',
        text: entry.text,
        isoTime: new Date(entry.timestamp).toISOString()
      };

      this.transcript.push(transcriptEntry);
      this.currentBuffer.delete(bufferKey);

      console.log(`[Zoom Capture] "${entry.speaker}": "${entry.text}"`);

      this.saveTranscript();
      sendTranscriptionData(entry.text, entry.speaker);
    },

    // Guardar transcripción en storage
    async saveTranscript() {
      try {
        const meetingId = this.getMeetingId();
        const storageKey = `transcript_${meetingId}`;

        await chrome.storage.local.set({
          [storageKey]: this.transcript,
          currentMeetingId: meetingId,
          lastUpdated: Date.now()
        });
      } catch (error) {
        console.error('[Zoom Capture] Error saving transcript:', error);
      }
    },

    // Cargar transcripción existente
    async loadExistingTranscript() {
      try {
        const meetingId = this.getMeetingId();
        const storageKey = `transcript_${meetingId}`;

        const result = await chrome.storage.local.get([storageKey]);
        if (result[storageKey] && Array.isArray(result[storageKey])) {
          this.transcript = result[storageKey];
          console.log(`[Zoom Capture] Loaded ${this.transcript.length} existing entries`);
        }
      } catch (error) {
        console.error('[Zoom Capture] Error loading transcript:', error);
      }
    },

    // Obtener ID único de la reunión desde la URL
    getMeetingId() {
      const url = window.location.href;
      // Zoom URLs: zoom.us/wc/123456789/join o zoom.us/j/123456789
      const match = url.match(/zoom\.us\/(?:wc|j)\/(\d+)/i);
      return match ? `zoom_${match[1]}` : `zoom_${Date.now()}`;
    },

    // Exportar transcripción
    exportTranscript() {
      for (const [key] of this.currentBuffer) {
        this.flushBuffer(key);
      }

      return {
        meetingId: this.getMeetingId(),
        platform: 'zoom',
        startTime: this.transcript[0]?.isoTime || new Date().toISOString(),
        endTime: new Date().toISOString(),
        entries: [...this.transcript],
        totalEntries: this.transcript.length,

        asText() {
          return this.entries.map(e =>
            `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.speaker}: ${e.text}`
          ).join('\n');
        },

        asMarkdown() {
          let md = `# Zoom Meeting Transcript\n\n`;
          md += `**Meeting ID:** ${this.meetingId}\n`;
          md += `**Date:** ${new Date(this.startTime).toLocaleDateString()}\n`;
          md += `**Duration:** ${this.startTime} - ${this.endTime}\n\n`;
          md += `---\n\n`;

          let currentSpeaker = '';
          for (const entry of this.entries) {
            if (entry.speaker !== currentSpeaker) {
              currentSpeaker = entry.speaker;
              md += `\n**${currentSpeaker}** *(${new Date(entry.timestamp).toLocaleTimeString()})*\n`;
            }
            md += `${entry.text} `;
          }

          return md;
        }
      };
    },

    // Detener captura
    stop() {
      console.log('[Zoom Capture] Stopping capture...');

      for (const [key] of this.currentBuffer) {
        this.flushBuffer(key);
      }

      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }

      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      this.saveTranscript();

      const exported = this.exportTranscript();
      console.log(`[Zoom Capture] Captured ${exported.totalEntries} entries`);

      return exported;
    },

    // Obtener estado actual
    getStatus() {
      return {
        isActive: this.observer !== null,
        entriesCount: this.transcript.length,
        lastEntry: this.transcript[this.transcript.length - 1] || null,
        meetingId: this.getMeetingId()
      };
    }
  };

  // ============================================
  // MICROSOFT TEAMS WEB CAPTION CAPTURE
  // ============================================

  const TeamsCaptionCapture = {
    observer: null,
    pollInterval: null,
    transcript: [],
    lastCaptionText: '',
    lastCaptionTime: 0,
    currentBuffer: new Map(),
    captionIdMap: new Map(), // Para tracking de captions ya procesados

    // Selectores DOM para captions de Teams Web (basados en data-tid attributes)
    SELECTORS: {
      // Contenedores principales de captions
      captionWrapper: '[data-tid="closed-caption-v2-window-wrapper"]',
      captionRenderer: '[data-tid="closed-captions-renderer"]',
      captionContainerAlt: '[data-tid*="closed-caption"]',
      // Elementos individuales de caption
      captionEntry: '.fui-ChatMessageCompact, [data-tid*="caption-entry"]',
      // Speaker name
      speakerName: '[data-tid="author"]',
      // Caption text
      captionText: '[data-tid="closed-caption-text"]',
      // Panel de asistentes
      attendeesTree: '[role="tree"][aria-label*="Attendees"], [role="tree"][aria-label*="Participants"]',
      participantItem: '[data-tid^="participantsInCall-"]',
      // Botón de personas (para abrir panel)
      peopleButton: 'button[data-tid="calling-toolbar-people-button"]'
    },

    // Iniciar captura
    start() {
      console.log('[Teams Capture] Starting caption capture...');

      this.transcript = [];
      this.lastCaptionText = '';
      this.currentBuffer.clear();
      this.captionIdMap.clear();

      // Cargar transcripción existente
      this.loadExistingTranscript();

      // Intentar encontrar captions
      this.findAndObserveCaptions();

      // Polling como fallback
      this.pollInterval = setInterval(() => {
        if (!this.observer) {
          this.findAndObserveCaptions();
        }
      }, 2000);
    },

    // Buscar contenedor de captions
    findAndObserveCaptions() {
      // Buscar por selectores principales
      let captionContainer = document.querySelector(this.SELECTORS.captionWrapper);

      if (!captionContainer) {
        captionContainer = document.querySelector(this.SELECTORS.captionRenderer);
      }

      if (!captionContainer) {
        captionContainer = document.querySelector(this.SELECTORS.captionContainerAlt);
      }

      // Buscar por data-tid genérico
      if (!captionContainer) {
        const allCaptionElements = document.querySelectorAll('[data-tid*="caption"]');
        for (const elem of allCaptionElements) {
          if (this.looksLikeCaptionContainer(elem)) {
            captionContainer = elem;
            break;
          }
        }
      }

      if (captionContainer) {
        console.log('[Teams Capture] Caption container found, setting up observer');
        this.setupObserver(captionContainer);
        return true;
      }

      // Observer de documento como fallback
      this.setupDocumentObserver();
      return false;
    },

    // Verificar si parece contenedor de captions
    looksLikeCaptionContainer(element) {
      if (!element) return false;

      // Debe tener texto o elementos hijos con texto
      const hasText = element.textContent?.trim().length > 0;
      // Verificar si tiene elementos de caption dentro
      const hasCaptionElements = element.querySelector(this.SELECTORS.captionText) !== null ||
                                 element.querySelector(this.SELECTORS.speakerName) !== null;

      return hasText || hasCaptionElements;
    },

    // Configurar MutationObserver
    setupObserver(container) {
      if (this.observer) {
        this.observer.disconnect();
      }

      this.observer = new MutationObserver((mutations) => {
        this.processMutations(mutations);
      });

      this.observer.observe(container, {
        childList: true,
        subtree: true,
        characterData: true,
        characterDataOldValue: true,
        attributes: true,
        attributeFilter: ['data-caption-id']
      });

      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      console.log('[Teams Capture] MutationObserver active');

      // Procesar captions existentes
      this.processExistingCaptions(container);
    },

    // Observer de documento como fallback
    setupDocumentObserver() {
      if (this.observer) return;

      this.observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                // Verificar data-tid attributes
                const dataTid = node.getAttribute?.('data-tid') || '';
                if (dataTid.includes('caption') || dataTid.includes('closed-caption')) {
                  this.observer.disconnect();
                  this.observer = null;
                  this.setupObserver(node);
                  return;
                }

                // Buscar dentro del nodo
                const captionContainer = node.querySelector?.(this.SELECTORS.captionWrapper) ||
                                        node.querySelector?.(this.SELECTORS.captionRenderer);
                if (captionContainer) {
                  this.observer.disconnect();
                  this.observer = null;
                  this.setupObserver(captionContainer);
                  return;
                }
              }
            }
          }
        }

        this.processMutations(mutations);
      });

      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });

      console.log('[Teams Capture] Document observer active (waiting for captions)');
    },

    // Procesar captions existentes en el contenedor
    processExistingCaptions(container) {
      const captionTextElements = container.querySelectorAll(this.SELECTORS.captionText);

      for (const textElem of captionTextElements) {
        const text = textElem.textContent?.trim();
        if (text) {
          const speaker = this.extractSpeakerFromCaptionElement(textElem);
          this.handleCaptionUpdate(text, speaker, this.generateCaptionId(textElem));
        }
      }
    },

    // Generar ID único para caption
    generateCaptionId(element) {
      // Intentar obtener ID existente
      let captionId = element.getAttribute?.('data-caption-id');
      if (captionId) return captionId;

      // Buscar en padres
      let parent = element.parentElement;
      while (parent) {
        captionId = parent.getAttribute?.('data-caption-id');
        if (captionId) return captionId;
        parent = parent.parentElement;
      }

      // Generar nuevo ID
      const randomStr = Math.random().toString(36).substring(2, 8);
      return `caption_${Date.now()}_${randomStr}`;
    },

    // Procesar mutaciones del DOM
    processMutations(mutations) {
      for (const mutation of mutations) {
        // Cambios de texto
        if (mutation.type === 'characterData') {
          const text = mutation.target.textContent?.trim();
          if (text && text !== mutation.oldValue?.trim()) {
            const speaker = this.extractSpeakerFromNode(mutation.target);
            const captionId = this.generateCaptionId(mutation.target);
            this.handleCaptionUpdate(text, speaker, captionId);
          }
        }

        // Nodos añadidos
        if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
          for (const node of mutation.addedNodes) {
            this.extractCaptionsFromNode(node);
          }
        }
      }
    },

    // Extraer captions de un nodo
    extractCaptionsFromNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text && text.length > 0) {
          const speaker = this.extractSpeakerFromNode(node);
          const captionId = this.generateCaptionId(node);
          this.handleCaptionUpdate(text, speaker, captionId);
        }
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      // Buscar elementos de caption text
      const captionTextElements = node.querySelectorAll
        ? node.querySelectorAll(this.SELECTORS.captionText)
        : [];

      for (const textElem of captionTextElements) {
        const text = textElem.textContent?.trim();
        if (text) {
          const speaker = this.extractSpeakerFromCaptionElement(textElem);
          const captionId = this.generateCaptionId(textElem);
          this.handleCaptionUpdate(text, speaker, captionId);
        }
      }

      // Verificar si el nodo mismo tiene caption text
      if (node.getAttribute?.('data-tid') === 'closed-caption-text') {
        const text = node.textContent?.trim();
        if (text) {
          const speaker = this.extractSpeakerFromCaptionElement(node);
          const captionId = this.generateCaptionId(node);
          this.handleCaptionUpdate(text, speaker, captionId);
        }
      }
    },

    // Extraer speaker de elemento de caption
    extractSpeakerFromCaptionElement(element) {
      if (!element) return 'Unknown';

      let current = element.parentElement;
      let maxDepth = 10;

      while (current && maxDepth > 0) {
        // Buscar elemento author con data-tid
        const authorElem = current.querySelector?.(this.SELECTORS.speakerName);
        if (authorElem) {
          const name = authorElem.innerText?.trim() || authorElem.textContent?.trim();
          if (name && name.length < 100) {
            return name;
          }
        }

        current = current.parentElement;
        maxDepth--;
      }

      return 'Unknown';
    },

    // Extraer speaker del contexto del nodo
    extractSpeakerFromNode(node) {
      return this.extractSpeakerFromCaptionElement(node);
    },

    // Manejar actualización de caption
    handleCaptionUpdate(text, speaker, captionId) {
      if (!text || text.length < 1) return;

      const now = Date.now();

      // Verificar si ya procesamos este caption (por ID)
      if (captionId && this.captionIdMap.has(captionId)) {
        const existingEntry = this.captionIdMap.get(captionId);
        // Actualizar si el texto cambió
        if (existingEntry.text !== text) {
          existingEntry.text = text;
          // Actualizar en transcript también
          const idx = this.transcript.findIndex(e => e.key === captionId);
          if (idx !== -1) {
            this.transcript[idx].text = text;
            this.saveTranscript();
          }
        }
        return;
      }

      const bufferKey = captionId || speaker || 'default';
      const existing = this.currentBuffer.get(bufferKey);

      if (existing?.timeoutId) {
        clearTimeout(existing.timeoutId);
      }

      if (existing && this.isTextUpdate(existing.text, text)) {
        this.currentBuffer.set(bufferKey, {
          text: text,
          timestamp: existing.timestamp,
          speaker: speaker,
          captionId: captionId,
          timeoutId: setTimeout(() => this.flushBuffer(bufferKey), 1200)
        });
      } else if (!existing || !this.isDuplicate(existing.text, text)) {
        if (existing) {
          this.flushBuffer(bufferKey);
        }

        this.currentBuffer.set(bufferKey, {
          text: text,
          timestamp: now,
          speaker: speaker,
          captionId: captionId,
          timeoutId: setTimeout(() => this.flushBuffer(bufferKey), 1200)
        });
      }
    },

    // Verificar si es actualización del mismo texto
    isTextUpdate(oldText, newText) {
      if (!oldText || !newText) return false;
      if (newText.startsWith(oldText) || newText.includes(oldText)) return true;
      if (oldText.length < newText.length && newText.startsWith(oldText.slice(0, -3))) return true;
      return false;
    },

    // Verificar duplicados
    isDuplicate(existingText, newText) {
      if (!existingText || !newText) return false;
      if (existingText === newText) return true;
      return this.calculateSimilarity(existingText, newText) > 0.85;
    },

    // Calcular similitud Sørensen-Dice
    calculateSimilarity(str1, str2) {
      if (str1 === str2) return 1;
      if (str1.length < 2 || str2.length < 2) return 0;

      const bigrams1 = new Set();
      for (let i = 0; i < str1.length - 1; i++) {
        bigrams1.add(str1.substring(i, i + 2).toLowerCase());
      }

      let intersection = 0;
      for (let i = 0; i < str2.length - 1; i++) {
        if (bigrams1.has(str2.substring(i, i + 2).toLowerCase())) {
          intersection++;
        }
      }

      return (2 * intersection) / (str1.length + str2.length - 2);
    },

    // Flush buffer y guardar entrada
    flushBuffer(bufferKey) {
      const entry = this.currentBuffer.get(bufferKey);
      if (!entry || !entry.text) return;

      // Verificar que no sea duplicado de la última entrada
      const lastEntry = this.transcript[this.transcript.length - 1];
      if (lastEntry && this.isDuplicate(lastEntry.text, entry.text)) {
        this.currentBuffer.delete(bufferKey);
        return;
      }

      const transcriptEntry = {
        timestamp: entry.timestamp,
        speaker: entry.speaker || 'Unknown',
        text: entry.text,
        isoTime: new Date(entry.timestamp).toISOString(),
        key: entry.captionId || bufferKey
      };

      this.transcript.push(transcriptEntry);
      this.currentBuffer.delete(bufferKey);

      // Guardar en mapa de IDs procesados
      if (entry.captionId) {
        this.captionIdMap.set(entry.captionId, { text: entry.text, speaker: entry.speaker });
      }

      console.log(`[Teams Capture] "${entry.speaker}": "${entry.text}"`);

      this.saveTranscript();
      sendTranscriptionData(entry.text, entry.speaker);
    },

    // Guardar transcripción en storage
    async saveTranscript() {
      try {
        const meetingId = this.getMeetingId();
        const storageKey = `transcript_${meetingId}`;

        await chrome.storage.local.set({
          [storageKey]: this.transcript,
          currentMeetingId: meetingId,
          lastUpdated: Date.now()
        });
      } catch (error) {
        console.error('[Teams Capture] Error saving transcript:', error);
      }
    },

    // Cargar transcripción existente
    async loadExistingTranscript() {
      try {
        const meetingId = this.getMeetingId();
        const storageKey = `transcript_${meetingId}`;

        const result = await chrome.storage.local.get([storageKey]);
        if (result[storageKey] && Array.isArray(result[storageKey])) {
          this.transcript = result[storageKey];
          // Reconstruir mapa de IDs
          for (const entry of this.transcript) {
            if (entry.key) {
              this.captionIdMap.set(entry.key, { text: entry.text, speaker: entry.speaker });
            }
          }
          console.log(`[Teams Capture] Loaded ${this.transcript.length} existing entries`);
        }
      } catch (error) {
        console.error('[Teams Capture] Error loading transcript:', error);
      }
    },

    // Obtener ID único de la reunión
    getMeetingId() {
      const url = window.location.href;
      // Teams URLs pueden tener diferentes formatos
      // teams.microsoft.com/l/meetup-join/19%3ameeting_xxx
      // teams.live.com/meet/xxx
      const meetupMatch = url.match(/meetup-join\/([^\/\?]+)/i);
      if (meetupMatch) {
        return `teams_${meetupMatch[1].substring(0, 20)}`;
      }

      const meetMatch = url.match(/meet\/([^\/\?]+)/i);
      if (meetMatch) {
        return `teams_${meetMatch[1]}`;
      }

      // Fallback con timestamp
      return `teams_${Date.now()}`;
    },

    // Exportar transcripción
    exportTranscript() {
      for (const [key] of this.currentBuffer) {
        this.flushBuffer(key);
      }

      return {
        meetingId: this.getMeetingId(),
        platform: 'teams',
        startTime: this.transcript[0]?.isoTime || new Date().toISOString(),
        endTime: new Date().toISOString(),
        entries: [...this.transcript],
        totalEntries: this.transcript.length,

        asText() {
          return this.entries.map(e =>
            `[${new Date(e.timestamp).toLocaleTimeString()}] ${e.speaker}: ${e.text}`
          ).join('\n');
        },

        asMarkdown() {
          let md = `# Teams Meeting Transcript\n\n`;
          md += `**Meeting ID:** ${this.meetingId}\n`;
          md += `**Date:** ${new Date(this.startTime).toLocaleDateString()}\n`;
          md += `**Duration:** ${this.startTime} - ${this.endTime}\n\n`;
          md += `---\n\n`;

          let currentSpeaker = '';
          for (const entry of this.entries) {
            if (entry.speaker !== currentSpeaker) {
              currentSpeaker = entry.speaker;
              md += `\n**${currentSpeaker}** *(${new Date(entry.timestamp).toLocaleTimeString()})*\n`;
            }
            md += `${entry.text} `;
          }

          return md;
        }
      };
    },

    // Detener captura
    stop() {
      console.log('[Teams Capture] Stopping capture...');

      for (const [key] of this.currentBuffer) {
        this.flushBuffer(key);
      }

      if (this.observer) {
        this.observer.disconnect();
        this.observer = null;
      }

      if (this.pollInterval) {
        clearInterval(this.pollInterval);
        this.pollInterval = null;
      }

      this.saveTranscript();

      const exported = this.exportTranscript();
      console.log(`[Teams Capture] Captured ${exported.totalEntries} entries`);

      return exported;
    },

    // Obtener estado actual
    getStatus() {
      return {
        isActive: this.observer !== null,
        entriesCount: this.transcript.length,
        lastEntry: this.transcript[this.transcript.length - 1] || null,
        meetingId: this.getMeetingId()
      };
    }
  };

  // ============================================
  // PLATFORM-SPECIFIC CAPTURE IMPLEMENTATIONS
  // ============================================

  // Google Meet caption capture
  function initMeetCapture() {
    console.log('[Meeting Transcriber] Initializing Google Meet capture...');
    MeetCaptionCapture.start();
  }

  // Zoom caption capture
  function initZoomCapture() {
    console.log('[Meeting Transcriber] Initializing Zoom capture...');
    ZoomCaptionCapture.start();
  }

  // Microsoft Teams caption capture
  function initTeamsCapture() {
    console.log('[Meeting Transcriber] Initializing Teams capture...');
    TeamsCaptionCapture.start();
  }

  // Clean up capture resources
  function cleanupCapture() {
    console.log('[Meeting Transcriber] Cleaning up capture resources...');

    switch (platform) {
      case 'meet':
        MeetCaptionCapture.stop();
        break;
      case 'zoom':
        ZoomCaptionCapture.stop();
        break;
      case 'teams':
        TeamsCaptionCapture.stop();
        break;
    }
  }

  // Send transcription data to background
  function sendTranscriptionData(text, speaker = 'Unknown') {
    if (!isRecording) return;

    chrome.runtime.sendMessage({
      action: 'TRANSCRIPTION_DATA',
      data: { text, speaker }
    }).catch(error => {
      console.error('[Meeting Transcriber] Error sending data:', error);
    });
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
