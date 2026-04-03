// Meeting Transcriber - Content Script
// Injected into Meet, Zoom, and Teams pages

(function() {
  'use strict';

  // ── Verificar si el contexto de la extensión sigue válido ──────────────────
  // Cuando se recarga la extensión con Meet abierto, Chrome invalida el contexto
  // del content script. Hay que detener el MutationObserver antes de que siga
  // disparando errores "Extension context invalidated".
  function isExtensionValid() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  }

  function emergencyStop() {
    // Desconectar todos los observers activos para que dejen de disparar
    try { MeetCaptionCapture.observer?.disconnect(); } catch {}
    try { ZoomCaptionCapture.observer?.disconnect(); } catch {}
    try { TeamsCaptionCapture.observer?.disconnect(); } catch {}
    try { clearInterval(MeetCaptionCapture.pollInterval); } catch {}
    try { clearInterval(ZoomCaptionCapture.pollInterval); } catch {}
    try { clearInterval(TeamsCaptionCapture.pollInterval); } catch {}
  }

  // State
  let isRecording = false;
  let platform = null;
  let healthCheckTimeout = null;

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
    wordCount: 0,
    lastSpeaker: null,

    // Selectores DOM para captions de Meet (estrategia multi-nivel)
    SELECTORS: {
      // Contenedor principal - múltiples fallbacks por orden de confiabilidad
      captionContainer: '[jsname="dsyhDe"], [data-panel-id="10"], .a4cQT, [jsname="YPqjbf"]',
      // Texto de caption - clases conocidas + atributos estables
      captionText: '[data-message-text], .CNusmb, .bj4p3b, .TBMuR span, [class*="caption"], [class*="subtitle"]',
      // Nombre del speaker
      speakerName: '[data-sender-name], .zs7s8d, .NWpY1d, [class*="speaker-name"], [class*="sender-name"]',
      // Región aria-live (muy estable entre versiones de Meet)
      ariaLiveRegion: '[aria-live="polite"], [aria-live="assertive"]',
      // Contenedor de captions activo
      captionsActive: '[jsname="Ypp7Cf"], .iOzk7, [data-panel-id="10"], [aria-label*="caption" i], [aria-label*="subtítulo" i]'
    },

    // Iniciar captura
    start() {
      console.log('[Meet Capture] Starting caption capture...');

      this.transcript = [];
      this.lastCaptionText = '';
      this.currentBuffer.clear();
      this.wordCount = 0;
      this.lastSpeaker = null;

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
      // Estrategia 1: Buscar por selectores de atributos estables
      for (const selector of [this.SELECTORS.captionContainer, this.SELECTORS.captionsActive]) {
        try {
          const element = document.querySelector(selector);
          if (element && this.looksLikeCaptionContainer(element)) {
            return element;
          }
        } catch (e) { /* selector inválido, ignorar */ }
      }

      // Estrategia 2: Regiones aria-live en la mitad inferior (muy fiable)
      const liveRegions = document.querySelectorAll(this.SELECTORS.ariaLiveRegion);
      for (const region of liveRegions) {
        const rect = region.getBoundingClientRect();
        // Captions suelen aparecer en el 40% inferior de la pantalla
        if (rect.top > window.innerHeight * 0.35 && rect.width > 100) {
          console.log('[Meet Capture] Found aria-live caption region');
          return region;
        }
      }

      // Estrategia 3: Buscar por aria-label que mencione captions/subtítulos
      const captionByLabel = document.querySelector('[aria-label*="caption" i], [aria-label*="subtitle" i], [aria-label*="subtítulo" i]');
      if (captionByLabel) return captionByLabel;

      // Estrategia 4: Buscar divs con texto que parezcan captions
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

      // aria-live es una señal muy fuerte de contenedor de captions
      if (element.hasAttribute('aria-live')) return true;

      // aria-label que mencione captions
      const ariaLabel = element.getAttribute('aria-label')?.toLowerCase() || '';
      if (ariaLabel.includes('caption') || ariaLabel.includes('subtitle') || ariaLabel.includes('subtítulo')) {
        return true;
      }

      // Fallback: elemento en la parte inferior con texto
      const rect = element.getBoundingClientRect();
      const isLowerHalf = rect.top > window.innerHeight * 0.35;
      const hasText = element.textContent?.trim().length > 0;

      return isLowerHalf && hasText;
    },

    // Configurar MutationObserver en el contenedor de captions
    setupObserver(container) {
      if (this.observer) {
        this.observer.disconnect();
      }

      this.captionContainer = container; // referencia para leer texto visible al hacer stop

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
        // Buscar si alguna mutación introduce el contenedor de captions
        for (const mutation of mutations) {
          if (mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                // Verificar si el nodo añadido es un aria-live (captions de Meet)
                if (node.getAttribute?.('aria-live')) {
                  const rect = node.getBoundingClientRect();
                  if (rect.top > window.innerHeight * 0.35) {
                    this.observer.disconnect();
                    this.observer = null;
                    this.setupObserver(node);
                    return;
                  }
                }
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
      if (!isExtensionValid()) { emergencyStop(); return; }

      for (const mutation of mutations) {
        // Cambios de texto en vivo — rastrear el estado más reciente en liveNodes
        if (mutation.type === 'characterData') {
          const text = mutation.target.textContent?.trim();
          if (text && text !== mutation.oldValue?.trim()) {
            // Guardar en liveNodes para capturarlo cuando sea eliminado
            this.trackLiveNode(mutation.target, text);
            this.handleCaptionUpdate(text, this.extractSpeaker(mutation.target));
          }
        }

        if (mutation.type === 'childList') {
          // NODOS ELIMINADOS: este es el momento dorado — Meet terminó de corregir la frase
          // El texto en removedNodes es el texto FINAL después de todas las correcciones de STT
          for (const node of mutation.removedNodes) {
            this.captureRemovedNode(node);
          }

          // Nodos añadidos
          for (const node of mutation.addedNodes) {
            this.extractCaptionsFromNode(node);
          }
        }
      }
    },

    // Mapa de nodos vivos → texto más reciente
    liveNodes: new WeakMap(),

    trackLiveNode(node, text) {
      this.liveNodes.set(node, { text, speaker: this.extractSpeaker(node) });
    },

    // Capturar texto final cuando Meet elimina un nodo de caption.
    // SOLO procesamos nodos que pasaron por trackLiveNode (tuvieron mutaciones characterData).
    // Esto evita capturar texto estático del DOM (menús, configuración, idiomas, etc.)
    // que nunca fue speech en vivo.
    captureRemovedNode(node) {
      // Nodo directo: solo si fue trackeado como speech en vivo
      const tracked = this.liveNodes.get(node);
      if (tracked?.text) {
        this.commitFinalText(tracked.text, tracked.speaker);
      }

      // Revisar hijos también (el nodo eliminado puede ser un contenedor)
      if (node.nodeType === Node.ELEMENT_NODE) {
        const children = node.querySelectorAll ? node.querySelectorAll('*') : [];
        for (const child of children) {
          const childTracked = this.liveNodes.get(child);
          if (childTracked?.text) {
            this.commitFinalText(childTracked.text, childTracked.speaker);
          }
        }
      }
    },

    // Guardar texto final al transcript directamente (sin buffer)
    commitFinalText(text, speaker) {
      if (!text || text.length < 3) return;
      const textLow = text.toLowerCase().trim();

      // Verificar duplicado contra las últimas entradas
      const lookback = Math.min(this.transcript.length, 30);
      for (let i = this.transcript.length - 1; i >= this.transcript.length - lookback; i--) {
        const existingLow = this.transcript[i].text.toLowerCase().trim();
        if (existingLow === textLow) return;
        if (existingLow.includes(textLow)) return;
      }

      // Si extiende la última entrada del mismo speaker, reemplazar
      const last = this.transcript[this.transcript.length - 1];
      if (last && last.speaker === (speaker || 'Unknown') && text.length > last.text.length) {
        const lastWords = last.text.toLowerCase().slice(-15).trim();
        if (lastWords.length >= 5 && textLow.includes(lastWords)) {
          const prevWords = last.text.trim().split(/\s+/).length;
          const newWords = text.trim().split(/\s+/).length;
          this.transcript[this.transcript.length - 1] = {
            timestamp: last.timestamp,
            speaker: speaker || last.speaker,
            text,
            isoTime: new Date(last.timestamp).toISOString()
          };
          this.wordCount += Math.max(0, newWords - prevWords);
          this.lastSpeaker = speaker || last.speaker;
          this.saveTranscript();
          console.log(`[Meet] Final (extended): "${text}"`);
          return;
        }
      }

      const entry = {
        timestamp: Date.now(),
        speaker: speaker || 'Unknown',
        text,
        isoTime: new Date().toISOString()
      };
      this.transcript.push(entry);
      this.wordCount += text.trim().split(/\s+/).filter(w => w).length;
      this.lastSpeaker = speaker || 'Unknown';
      console.log(`[Meet] Final: "${speaker}": "${text}"`);
      this.saveTranscript();
    },

    // Extraer captions de un nodo
    extractCaptionsFromNode(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent?.trim();
        if (text && text.length > 1) {
          this.handleCaptionUpdate(text, this.extractSpeaker(node));
        }
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) return;

      // Intento 1: selectores específicos conocidos
      const captionElements = node.querySelectorAll
        ? node.querySelectorAll(this.SELECTORS.captionText)
        : [];

      if (captionElements.length > 0) {
        for (const elem of captionElements) {
          const text = elem.textContent?.trim();
          if (text) {
            this.handleCaptionUpdate(text, this.extractSpeaker(elem));
          }
        }
        return;
      }

      // Intento 2: fallback agresivo - cualquier texto del nodo que tenga sentido
      // (evitar menús, botones, y textos muy largos)
      const tag = node.tagName?.toLowerCase();
      if (['button', 'input', 'select', 'svg', 'path', 'img'].includes(tag)) return;

      const speaker = this.extractSpeaker(node);

      // Construir texto excluyendo el elemento del speaker para evitar "NombreTexto"
      let allText = '';
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) {
          allText += child.textContent;
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          // Excluir si el hijo es el elemento del speaker
          const childText = child.textContent?.trim();
          if (speaker !== 'Unknown' && childText === speaker) continue;
          allText += child.textContent;
        }
      }
      allText = allText.trim();

      // Si el texto empieza con el nombre del speaker (concatenación), quitarlo
      if (speaker !== 'Unknown' && allText.startsWith(speaker)) {
        allText = allText.substring(speaker.length).trim();
      }

      if (allText && allText.length > 1 && allText.length < 600) {
        this.handleCaptionUpdate(allText, speaker);
      }
    },

    // Extraer nombre del speaker del contexto del nodo
    extractSpeaker(node) {
      if (!node) return 'Unknown';

      let current = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      let maxDepth = 12;

      while (current && maxDepth > 0) {
        // 1. Atributo data-sender-name (estable entre versiones de Meet)
        const senderName = current.getAttribute?.('data-sender-name');
        if (senderName?.trim()) return senderName.trim();

        // 2. Selectores conocidos de speaker
        const speakerElem = current.querySelector?.(this.SELECTORS.speakerName);
        if (speakerElem) {
          const name = speakerElem.textContent?.trim();
          if (name && name.length > 0 && name.length < 80) return name;
        }

        // 3. Buscar el primer hijo de texto corto del contenedor padre
        //    Meet suele poner: <div>[Nombre]</div><div>[Texto caption]</div>
        if (current.children?.length >= 2) {
          const firstChild = current.children[0];
          const text = firstChild.textContent?.trim();
          // Un nombre suele ser corto (2-50 chars) y no contener signos de puntuación del speech
          if (text && text.length >= 2 && text.length <= 50 && !/[.!?,]$/.test(text)) {
            // Verificar que el nodo actual contiene el nodo fuente
            if (current.contains(node instanceof Node ? node : null) ||
                current.contains(node?.parentElement)) {
              return text;
            }
          }
        }

        // 4. aria-label del contenedor puede incluir el nombre
        const ariaLabel = current.getAttribute?.('aria-label');
        if (ariaLabel && ariaLabel.length < 80 && !ariaLabel.toLowerCase().includes('caption')) {
          return ariaLabel.trim();
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

      // --- Paso 1: buscar si CUALQUIER entrada del buffer es una actualización de este texto ---
      // Meet actualiza el caption en vivo; el speaker puede alternar entre Unknown y el nombre real,
      // así que buscamos en todos los buffers, no solo en el del mismo speaker.
      let matchKey = null;
      let matchEntry = null;
      for (const [key, entry] of this.currentBuffer) {
        if (this.isTextUpdate(entry.text, text)) {
          matchKey = key;
          matchEntry = entry;
          break;
        }
      }

      if (matchKey && matchEntry) {
        // Es una actualización de un caption ya en buffer
        clearTimeout(matchEntry.timeoutId);
        // Preferir el speaker real sobre Unknown
        const resolvedSpeaker = (speaker && speaker !== 'Unknown')
          ? speaker
          : (matchEntry.speaker && matchEntry.speaker !== 'Unknown' ? matchEntry.speaker : speaker);

        // Si el speaker cambió, mover la entrada a la nueva key
        const newKey = resolvedSpeaker || matchKey;
        if (newKey !== matchKey) {
          this.currentBuffer.delete(matchKey);
        }
        this.currentBuffer.set(newKey, {
          text: text,
          timestamp: matchEntry.timestamp,
          speaker: resolvedSpeaker,
          timeoutId: setTimeout(() => this.flushBuffer(newKey), 2000)
        });
        return;
      }

      // --- Paso 2: verificar contra las últimas 60 entradas del transcript ---
      // IMPORTANTE: solo saltamos si el transcript YA CONTIENE este texto (entrada más larga existente).
      // NO saltamos si el nuevo texto extiende una entrada previa — eso es contenido nuevo que hay que guardar.
      // Esto corrige el caso: buffer flush "Hola hola, cómo están" → Meet sigue → "Hola hola, cómo están que vamos a hacer..."
      // El texto extendido NO es duplicado, es la continuación.
      const lookback = Math.min(this.transcript.length, 60);
      const textLow = text.toLowerCase().trim();
      for (let i = this.transcript.length - 1; i >= this.transcript.length - lookback; i--) {
        const existingLow = this.transcript[i].text.toLowerCase().trim();
        if (existingLow === textLow) return;         // idéntico → saltar
        if (existingLow.includes(textLow)) return;  // ya capturado dentro de una entrada más larga → saltar
        // NO usar similitud aquí: dos fragmentos consecutivos de la misma oración
        // tendrán similitud alta aunque sean contenido diferente.
      }

      // --- Paso 3: texto nuevo — crear entrada en buffer ---
      // 4000ms da más tiempo a Meet para terminar de corregir su reconocimiento de voz
      // antes de hacer flush. Cuanto más alto, más completas las frases; cuanto más bajo,
      // más rápido aparece en el transcript pero con más snapshots intermedios.
      const bufferKey = (speaker && speaker !== 'Unknown') ? speaker : ('unknown_' + now);
      this.currentBuffer.set(bufferKey, {
        text: text,
        timestamp: now,
        speaker: speaker,
        timeoutId: setTimeout(() => this.flushBuffer(bufferKey), 4000)
      });
    },

    // Verificar si el nuevo texto es una actualización/extensión del texto en buffer.
    // IMPORTANTE: solo actualizar cuando el nuevo texto es IGUAL o MÁS LARGO.
    // Si el nuevo texto es más corto que el del buffer, NO es una actualización —
    // puede ser un parpadeo de Meet, no queremos perder el texto ya acumulado.
    isTextUpdate(oldText, newText) {
      if (!oldText || !newText) return false;

      const old = oldText.toLowerCase().trim();
      const nw  = newText.toLowerCase().trim();

      // El nuevo texto extiende el viejo (es igual o más largo y lo contiene)
      if (nw.length >= old.length && (nw.startsWith(old) || nw.includes(old))) return true;

      // El nuevo texto es prefijo aproximado extendido del viejo (tolerancia 3 chars, solo si crece)
      if (nw.length >= old.length && nw.startsWith(old.slice(0, -3))) return true;

      return false;
    },

    // Verificar duplicados (case-insensitive + similitud)
    isDuplicate(existingText, newText) {
      if (!existingText || !newText) return false;

      const a = existingText.toLowerCase().trim();
      const b = newText.toLowerCase().trim();

      if (a === b) return true;

      // Solo es duplicado si el EXISTENTE ya contiene el texto nuevo.
      // NO al revés: si el nuevo contiene al existente, es una extensión (más contenido),
      // no un duplicado — eso lo maneja el extend-replace en flushBuffer.
      if (a.includes(b)) return true;

      return false;
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

      const lastEntry = this.transcript[this.transcript.length - 1];

      const transcriptEntry = {
        timestamp: entry.timestamp,
        speaker: entry.speaker || 'Unknown',
        text: entry.text,
        isoTime: new Date(entry.timestamp).toISOString()
      };

      // PRIMERO: si la nueva entrada extiende la última del mismo speaker, reemplazarla.
      // Debe ir ANTES del chequeo isDuplicate porque isDuplicate(a, b) devuelve true
      // cuando b contiene a — lo que ocurre exactamente cuando b extiende a.
      if (
        lastEntry &&
        lastEntry.speaker === transcriptEntry.speaker &&
        transcriptEntry.text.length > lastEntry.text.length
      ) {
        const lastWords = lastEntry.text.toLowerCase().slice(-15).trim();
        if (lastWords.length >= 8 && transcriptEntry.text.toLowerCase().includes(lastWords)) {
          this.transcript[this.transcript.length - 1] = transcriptEntry;
          this.currentBuffer.delete(bufferKey);
          const prevWords = lastEntry.text.trim().split(/\s+/).length;
          const newWords = transcriptEntry.text.trim().split(/\s+/).length;
          this.wordCount += Math.max(0, newWords - prevWords);
          this.lastSpeaker = transcriptEntry.speaker;
          console.log(`[Meet Capture] Extended: "${transcriptEntry.speaker}": "${transcriptEntry.text}"`);
          this.saveTranscript();
          return;
        }
      }

      // SEGUNDO: descartar si es duplicado real (mismo texto o ya contenido en la última entrada)
      if (lastEntry && this.isDuplicate(lastEntry.text, entry.text)) {
        this.currentBuffer.delete(bufferKey);
        return;
      }

      this.transcript.push(transcriptEntry);
      this.currentBuffer.delete(bufferKey);

      this.wordCount += entry.text.trim().split(/\s+/).filter(w => w).length;
      this.lastSpeaker = entry.speaker || 'Unknown';

      console.log(`[Meet Capture] "${entry.speaker}": "${entry.text}"`);

      this.saveTranscript();
      sendTranscriptionData(entry.text, entry.speaker);
    },

    // Guardar transcripción en storage
    async saveTranscript() {
      if (!isExtensionValid()) { emergencyStop(); return; }
      try {
        const meetingId = this.getMeetingId();
        const storageKey = `transcript_${meetingId}`;

        await chrome.storage.local.set({
          [storageKey]: this.transcript,
          currentMeetingId: meetingId,
          lastUpdated: Date.now()
        });
      } catch (error) {
        if (error.message?.includes('Extension context invalidated')) {
          emergencyStop();
        } else {
          console.error('[Meet Capture] Error saving transcript:', error);
        }
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

      case 'GET_STATS':
        sendResponse({
          isRecording,
          wordCount: capture ? capture.wordCount : 0,
          entryCount: capture ? capture.transcript.length : 0,
          lastSpeaker: capture ? capture.lastSpeaker : null
        });
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

    // Verificar salud después de 20 segundos
    if (healthCheckTimeout) clearTimeout(healthCheckTimeout);
    healthCheckTimeout = setTimeout(() => {
      const capture = getActiveCapture();
      if (isRecording && capture && capture.wordCount === 0) {
        chrome.runtime.sendMessage({
          action: 'CAPTION_WARNING',
          message: 'No se detectan subtítulos. Activa los subtítulos (CC) en la reunión.'
        }).catch(() => {});
      }
    }, 20000);
  }

  // Stop transcription
  function stopTranscription() {
    if (!isRecording) {
      console.log('[Meeting Transcriber] Not currently recording');
      return;
    }

    isRecording = false;
    console.log('[Meeting Transcriber] Stopping transcription...');

    if (healthCheckTimeout) {
      clearTimeout(healthCheckTimeout);
      healthCheckTimeout = null;
    }

    const capture = getActiveCapture();

    // 1. Capturar nodos que aún estén visibles en el DOM pero que sí fueron trackeados
    //    como speech en vivo (characterData mutations). Esto cubre los últimos segundos
    //    de caption que Meet no eliminó antes de que paráramos.
    //    NO leer textContent del contenedor — eso captura menús y UI también.
    if (capture && capture.liveNodes && capture.captionContainer) {
      const container = capture.captionContainer;
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_ALL);
      let node;
      while ((node = walker.nextNode())) {
        const tracked = capture.liveNodes.get(node);
        if (tracked?.text) {
          capture.commitFinalText(tracked.text, tracked.speaker);
        }
      }
    }

    // 2. Flush del buffer por si aún hay entradas pendientes
    if (capture && capture.currentBuffer) {
      for (const [key, entry] of capture.currentBuffer) {
        clearTimeout(entry.timeoutId);
        capture.flushBuffer(key);
      }
    }

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
    wordCount: 0,
    lastSpeaker: null,

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

      this.wordCount += entry.text.trim().split(/\s+/).filter(w => w).length;
      this.lastSpeaker = entry.speaker || 'Unknown';

      console.log(`[Zoom Capture] "${entry.speaker}": "${entry.text}"`);

      this.saveTranscript();
      sendTranscriptionData(entry.text, entry.speaker);
    },

    // Guardar transcripción en storage
    async saveTranscript() {
      if (!isExtensionValid()) { emergencyStop(); return; }
      try {
        const meetingId = this.getMeetingId();
        const storageKey = `transcript_${meetingId}`;

        await chrome.storage.local.set({
          [storageKey]: this.transcript,
          currentMeetingId: meetingId,
          lastUpdated: Date.now()
        });
      } catch (error) {
        if (error.message?.includes('Extension context invalidated')) {
          emergencyStop();
        } else {
          console.error('[Zoom Capture] Error saving transcript:', error);
        }
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
    wordCount: 0,
    lastSpeaker: null,

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

      this.wordCount += entry.text.trim().split(/\s+/).filter(w => w).length;
      this.lastSpeaker = entry.speaker || 'Unknown';

      console.log(`[Teams Capture] "${entry.speaker}": "${entry.text}"`);

      this.saveTranscript();
      sendTranscriptionData(entry.text, entry.speaker);
    },

    // Guardar transcripción en storage
    async saveTranscript() {
      if (!isExtensionValid()) { emergencyStop(); return; }
      try {
        const meetingId = this.getMeetingId();
        const storageKey = `transcript_${meetingId}`;

        await chrome.storage.local.set({
          [storageKey]: this.transcript,
          currentMeetingId: meetingId,
          lastUpdated: Date.now()
        });
      } catch (error) {
        if (error.message?.includes('Extension context invalidated')) {
          emergencyStop();
        } else {
          console.error('[Teams Capture] Error saving transcript:', error);
        }
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
    if (!isExtensionValid()) { emergencyStop(); return; }

    chrome.runtime.sendMessage({
      action: 'TRANSCRIPTION_DATA',
      data: { text, speaker }
    }).catch(() => {
      // El popup puede no estar abierto — ignorar silenciosamente
    });
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
