# Testing Guide - Meeting Transcriber Extension

## Pre-requisitos

### 1. Configurar EmailJS (obligatorio para test de email)

1. Crear cuenta en https://www.emailjs.com/
2. Agregar servicio de email (Gmail, Outlook, etc.)
3. Crear template con variables:
   - `{{to_email}}` - Email destino
   - `{{to_name}}` - Nombre destinatario
   - `{{subject}}` - Asunto
   - `{{message}}` - Cuerpo del mensaje
4. Editar `background.js` líneas 14-18:

```javascript
const EMAILJS_CONFIG = {
  SERVICE_ID: 'service_xxxxxx',      // Tu Service ID
  TEMPLATE_ID: 'template_xxxxxx',    // Tu Template ID
  PUBLIC_KEY: 'AbCdEfGhIjKlMnOp',    // Tu Public Key
  RECIPIENT_EMAIL: 'tu-email@ejemplo.com'
};
```

### 2. Instalar extensión en Chrome

```
1. Abrir chrome://extensions/
2. Activar "Developer mode" (esquina superior derecha)
3. Click "Load unpacked"
4. Seleccionar carpeta: meeting-transcriber-extension/
5. Verificar que aparece "Meeting Transcriber" sin errores
```

---

## Checklist de Testing

### Fase 1: Instalación y UI Base

| # | Test | Pasos | Resultado Esperado | ✓ |
|---|------|-------|-------------------|---|
| 1.1 | Instalación limpia | Cargar extensión en Chrome | Icono aparece en toolbar sin errores |   |
| 1.2 | Popup sin reunión | Click en icono en tab normal (google.com) | Badge "No meeting detected" rojo, botón deshabilitado |   |
| 1.3 | Service worker activo | chrome://extensions/ > "Service worker" | Link visible, sin errores en consola |   |

### Fase 2: Detección de Plataforma

| # | Test | Pasos | Resultado Esperado | ✓ |
|---|------|-------|-------------------|---|
| 2.1 | Detectar Google Meet | Abrir meet.google.com, click popup | Badge verde "Google Meet" |   |
| 2.2 | Detectar Zoom | Abrir zoom.us/wc/..., click popup | Badge azul "Zoom" |   |
| 2.3 | Detectar Teams | Abrir teams.microsoft.com, click popup | Badge morado "Microsoft Teams" |   |
| 2.4 | Botón habilitado | En cualquier plataforma | Botón "Start Transcription" activo |   |

### Fase 3: Captura de Transcripción (Google Meet)

| # | Test | Pasos | Resultado Esperado | ✓ |
|---|------|-------|-------------------|---|
| 3.1 | Activar captions | En Meet: ... > Turn on captions | Subtítulos visibles en pantalla |   |
| 3.2 | Iniciar grabación | Popup > "Start Transcription" | Indicador rojo pulsante, badge "REC" |   |
| 3.3 | Captura de texto | Hablar en la reunión | Consola muestra `[Meet Capture] "Speaker": "texto"` |   |
| 3.4 | Persistencia | Cerrar/abrir popup | Estado "Recording" se mantiene |   |
| 3.5 | Detener grabación | Popup > "Stop Transcription" | Indicador verde, aparece sección envío |   |

### Fase 4: Sección de Envío

| # | Test | Pasos | Resultado Esperado | ✓ |
|---|------|-------|-------------------|---|
| 4.1 | Preview visible | Detener transcripción | Vista previa con texto capturado |   |
| 4.2 | Metadata correcta | Revisar sección | Duración y conteo de palabras correcto |   |
| 4.3 | Campo nombre | Escribir "Acme Corp" | Input acepta texto |   |
| 4.4 | Botón enviar | Con transcripción válida | Botón "Enviar transcripción" activo |   |

### Fase 5: Envío de Email

| # | Test | Pasos | Resultado Esperado | ✓ |
|---|------|-------|-------------------|---|
| 5.1 | Envío exitoso | Click "Enviar transcripción" | Spinner, luego "✓ Enviado" verde |   |
| 5.2 | Email recibido | Revisar bandeja de entrada | Email con asunto "Reunión con Acme Corp - DD/MM/YYYY" |   |
| 5.3 | Formato correcto | Leer contenido del email | Header + transcripción + footer |   |
| 5.4 | Limpieza post-envío | Esperar 2 segundos | Sección de envío desaparece |   |

### Fase 6: Casos de Error

| # | Test | Pasos | Resultado Esperado | ✓ |
|---|------|-------|-------------------|---|
| 6.1 | Sin configurar EmailJS | Enviar sin config | Error: "EmailJS no está configurado" |   |
| 6.2 | Sin transcripción | Detener inmediatamente | Preview: "No se capturó ninguna transcripción" |   |
| 6.3 | Sin captions activos | Grabar sin activar CC | Consola: "Document observer active (waiting...)" |   |
| 6.4 | Tab cerrado | Cerrar tab durante grabación | Transcripción se detiene automáticamente |   |
| 6.5 | Navegar fuera | Ir a otra URL durante grabación | Transcripción se detiene automáticamente |   |

---

## Scripts de Prueba Manual

### Test Google Meet

```
PREPARACIÓN:
1. Abrir https://meet.google.com/
2. Crear o unirse a una reunión de prueba
3. Activar subtítulos: Menú (...) > "Turn on captions"

EJECUCIÓN:
4. Click en icono de extensión
5. Verificar: Badge "Google Meet" verde
6. Click "Start Transcription"
7. Verificar: Indicador rojo pulsante, badge "REC" en icono
8. Hablar: "Hola, esta es una prueba de transcripción"
9. Esperar 3 segundos (debounce)
10. Abrir DevTools (F12) > Console
11. Verificar: Logs con [Meet Capture] y texto capturado
12. Click "Stop Transcription"
13. Verificar: Sección de envío visible con preview
14. Escribir nombre: "Test Meeting"
15. Click "Enviar transcripción"
16. Verificar email recibido
```

### Test Zoom Web

```
PREPARACIÓN:
1. Abrir reunión Zoom en navegador (zoom.us/wc/...)
2. Activar live transcription si disponible

EJECUCIÓN:
3. Click en icono de extensión
4. Verificar: Badge "Zoom" azul
5. Click "Start Transcription"
6. Hablar y verificar captura en consola
7. Detener y verificar flujo de envío
```

### Test Microsoft Teams

```
PREPARACIÓN:
1. Abrir reunión en teams.microsoft.com
2. Activar live captions: ... > "Turn on live captions"

EJECUCIÓN:
3. Click en icono de extensión
4. Verificar: Badge "Microsoft Teams" morado
5. Seguir mismo flujo que Meet
```

---

## Comandos de Debugging (DevTools Console)

### Inspeccionar Storage

```javascript
// Ver todo el storage
chrome.storage.local.get(null, console.log);

// Ver estado de grabación
chrome.storage.local.get(['isRecording', 'recordingTabId'], console.log);

// Ver transcripción actual
chrome.storage.local.get(['currentMeetingId'], (r) => {
  const key = `transcript_${r.currentMeetingId}`;
  chrome.storage.local.get([key], console.log);
});

// Ver transcripción completada
chrome.storage.local.get([
  'completedTranscription',
  'transcriptionText',
  'transcriptionStartTime',
  'transcriptionEndTime'
], console.log);

// Limpiar storage (reset completo)
chrome.storage.local.clear(() => console.log('Storage cleared'));
```

### Inspeccionar Content Script (en tab de reunión)

```javascript
// Verificar si content script está activo
// En la consola del tab de Meet/Zoom/Teams:

// Enviar mensaje al content script
chrome.runtime.sendMessage({action: 'GET_STATUS'}, console.log);

// Obtener transcripción actual
chrome.runtime.sendMessage({action: 'GET_TRANSCRIPT'}, console.log);

// Exportar transcripción
chrome.runtime.sendMessage({action: 'EXPORT_TRANSCRIPT'}, console.log);
```

### Inspeccionar Service Worker

```javascript
// En chrome://extensions/ > Service Worker (inspect)

// Ver transcripciones activas
console.log(activeTranscriptions);

// Verificar config de EmailJS
console.log(EMAILJS_CONFIG);
```

### Verificar DOM de Captions

```javascript
// Google Meet - Buscar contenedor de captions
document.querySelectorAll('[data-message-text]');
document.querySelectorAll('.CNusmb');
document.querySelectorAll('[jsname="dsyhDe"]');

// Zoom - Buscar captions
document.querySelector('#live-transcription-subtitle');
document.querySelectorAll('[class*="live-transcription"]');

// Teams - Buscar captions
document.querySelector('[data-tid="closed-caption-v2-window-wrapper"]');
document.querySelectorAll('[data-tid*="caption"]');
```

---

## Errores Comunes y Diagnóstico

### Error: "No meeting detected"

**Síntoma:** Badge rojo, botón deshabilitado en página de reunión

**Diagnóstico:**
```javascript
// Verificar URL actual
console.log(window.location.hostname);
```

**Causas posibles:**
1. URL no coincide con patrones de host_permissions
2. Tab no está activo al abrir popup

**Fix:** Verificar que la URL sea exactamente:
- `meet.google.com/*`
- `*.zoom.us/*`
- `teams.microsoft.com/*` o `teams.live.com/*`

---

### Error: Captions no se capturan

**Síntoma:** Recording activo pero consola no muestra texto

**Diagnóstico:**
```javascript
// Verificar si observer está activo
chrome.runtime.sendMessage({action: 'GET_STATUS'}, console.log);
// Debe mostrar: captureStatus.isActive = true
```

**Causas posibles:**
1. Captions no activados en la plataforma
2. Selectores DOM obsoletos (plataforma actualizó UI)
3. MutationObserver no encontró contenedor

**Fix:**
1. Activar captions manualmente en la reunión
2. Verificar selectores en consola (ver sección "Verificar DOM")
3. Actualizar selectores en `content.js` si cambiaron

---

### Error: "EmailJS no está configurado"

**Síntoma:** Error al enviar transcripción

**Diagnóstico:**
```javascript
// En Service Worker console
console.log(EMAILJS_CONFIG);
// Verificar que no tenga valores "YOUR_..."
```

**Fix:** Editar `background.js` con credenciales reales de EmailJS

---

### Error: Email no llega

**Síntoma:** "✓ Enviado" pero no hay email

**Diagnóstico:**
1. Revisar spam/junk folder
2. Verificar logs en EmailJS dashboard
3. Verificar RECIPIENT_EMAIL es correcto

**Fix:**
1. Whitelist email de EmailJS
2. Verificar template tiene variable `{{to_email}}`
3. Verificar límite de emails gratuitos de EmailJS

---

### Error: Transcripción duplicada

**Síntoma:** Mismo texto aparece múltiples veces

**Diagnóstico:**
```javascript
// Ver transcripción completa
chrome.runtime.sendMessage({action: 'GET_TRANSCRIPT'}, (r) => {
  console.log(r.entries.map(e => e.text));
});
```

**Causa:** Algoritmo de deduplicación no detectó similitud

**Fix:** Ajustar umbral de similitud en `isDuplicate()` (actualmente 0.85)

---

### Error: Service Worker inactivo

**Síntoma:** Extensión no responde

**Diagnóstico:**
```
chrome://extensions/ > Meeting Transcriber
- Si dice "Service worker (Inactive)", hay error
- Click "Service worker" para ver consola
```

**Fix:**
1. Revisar errores de sintaxis en `background.js`
2. Reload extensión
3. Si persiste, verificar manifest.json

---

## Reporte de Bugs Encontrados

### Template de Reporte

```markdown
## Bug #X: [Título descriptivo]

**Severidad:** Critical / High / Medium / Low

**Pasos para reproducir:**
1. ...
2. ...

**Resultado actual:**
...

**Resultado esperado:**
...

**Entorno:**
- Chrome version:
- OS:
- Plataforma de reunión:

**Logs relevantes:**
```
[pegar logs de consola]
```

**Fix sugerido:**
...

**Archivos afectados:**
- [ ] manifest.json
- [ ] popup.html
- [ ] popup.js
- [ ] background.js
- [ ] content.js
```

---

## Matriz de Compatibilidad

| Plataforma | Captura Captions | Identificación Speaker | Storage | Email |
|------------|-----------------|----------------------|---------|-------|
| Google Meet | ✓ Implementado | ✓ Implementado | ✓ | ✓ |
| Zoom Web | ✓ Implementado | ✓ Implementado | ✓ | ✓ |
| Teams Web | ✓ Implementado | ✓ Implementado | ✓ | ✓ |
| Zoom Desktop | N/A (solo web) | N/A | N/A | N/A |
| Teams Desktop | N/A (solo web) | N/A | N/A | N/A |

---

## Notas Adicionales

### Limitaciones Conocidas

1. **Requiere captions activos**: La extensión captura subtítulos renderizados en DOM, no audio
2. **Solo navegador Chrome**: Manifest V3 específico de Chromium
3. **Selectores pueden cambiar**: Las plataformas actualizan su UI frecuentemente
4. **EmailJS límite gratuito**: 200 emails/mes en plan free

### Performance

- MutationObserver tiene debounce de 1.2-1.5 segundos
- Storage se actualiza en cada entrada (puede optimizarse con batch)
- Transcript se guarda por meetingId (no se pierde al refrescar)

### Seguridad

- No se captura audio, solo texto visible
- Credenciales EmailJS en código (considerar cifrar o usar chrome.storage)
- Storage local (no se envía a servidores excepto EmailJS)
