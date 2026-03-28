# Meeting Transcriber - Chrome Extension

Extensión de Chrome que transcribe reuniones de **Google Meet**, **Zoom** y **Microsoft Teams** en tiempo real, capturando los subtítulos/captions y enviando un resumen por email al finalizar.

## Plataformas soportadas

| Plataforma | Estado | Notas |
|------------|--------|-------|
| Google Meet | Completo | Requiere activar captions (CC) |
| Zoom Web | Completo | Requiere activar Live Transcription |
| Microsoft Teams | Completo | Requiere activar Live Captions |

---

## Instalacion en Chrome (Modo Desarrollador)

1. **Descarga o clona este repositorio** en tu computadora

2. **Abre Chrome** y navega a:
   ```
   chrome://extensions
   ```

3. **Activa el Modo Desarrollador**
   - En la esquina superior derecha, activa el toggle "Developer mode"

4. **Carga la extension**
   - Click en "Load unpacked"
   - Selecciona la carpeta `meeting-transcriber-extension`

5. **Fija la extension** (opcional pero recomendado)
   - Click en el icono de puzzle (extensiones) en la barra de Chrome
   - Click en el pin junto a "Meeting Transcriber"

---

## Configuracion de EmailJS

La extension usa [EmailJS](https://www.emailjs.com/) para enviar las transcripciones por email sin necesidad de backend.

### Paso 1: Crear cuenta en EmailJS

1. Ve a [emailjs.com](https://www.emailjs.com/)
2. Click en "Sign Up Free"
3. Crea tu cuenta (el plan gratuito incluye 200 emails/mes)

### Paso 2: Agregar un servicio de email

1. En el dashboard de EmailJS, ve a **Email Services**
2. Click en **Add New Service**
3. Selecciona tu proveedor:
   - **Gmail**: Recomendado, facil de configurar
   - **Outlook/Hotmail**: Tambien funciona bien
   - **Otros**: SMTP personalizado disponible
4. Sigue las instrucciones para conectar tu cuenta
5. **Copia el Service ID** (ejemplo: `service_abc123`)

### Paso 3: Crear template de email

1. Ve a **Email Templates**
2. Click en **Create New Template**
3. Configura el template:

**Subject:**
```
{{subject}}
```

**Content (HTML o texto):**
```html
<h2>Transcripcion de Reunion</h2>

<p><strong>Reunion con:</strong> {{recipient_name}}</p>
<p><strong>Fecha:</strong> {{meeting_date}}</p>
<p><strong>Hora:</strong> {{meeting_time}}</p>
<p><strong>Duracion:</strong> {{meeting_duration}}</p>
<p><strong>Plataforma:</strong> {{meeting_platform}}</p>

<hr>

<h3>Transcripcion:</h3>
<pre>{{message}}</pre>
```

**Variables disponibles en el template:**

| Variable | Descripcion |
|----------|-------------|
| `{{to_email}}` | Email destinatario (configurado en extension) |
| `{{to_name}}` | Nombre del destinatario |
| `{{subject}}` | Asunto del email |
| `{{message}}` | Transcripcion completa formateada |
| `{{recipient_name}}` | Nombre de la empresa/persona de la reunion |
| `{{meeting_date}}` | Fecha de la reunion |
| `{{meeting_time}}` | Hora de inicio |
| `{{meeting_duration}}` | Duracion total |
| `{{meeting_platform}}` | Google Meet, Zoom, o Teams |

4. **Guarda el template**
5. **Copia el Template ID** (ejemplo: `template_xyz789`)

### Paso 4: Obtener Public Key

1. Ve a **Account** en el menu lateral
2. En la seccion **API Keys**, copia tu **Public Key**
   - Ejemplo: `AbCdEfGhIjKlMnOp`

### Paso 5: Configurar credenciales en la extension

1. Abre el archivo `background.js` en un editor de texto

2. Busca la seccion `EMAILJS_CONFIG` (linea 13-18):

```javascript
const EMAILJS_CONFIG = {
  SERVICE_ID: 'YOUR_SERVICE_ID',      // Pega tu Service ID aqui
  TEMPLATE_ID: 'YOUR_TEMPLATE_ID',    // Pega tu Template ID aqui
  PUBLIC_KEY: 'YOUR_PUBLIC_KEY',      // Pega tu Public Key aqui
  RECIPIENT_EMAIL: 'your-email@example.com'  // Tu email donde recibir transcripciones
};
```

3. Reemplaza los valores:

```javascript
const EMAILJS_CONFIG = {
  SERVICE_ID: 'service_abc123',
  TEMPLATE_ID: 'template_xyz789',
  PUBLIC_KEY: 'AbCdEfGhIjKlMnOp',
  RECIPIENT_EMAIL: 'tu-email@gmail.com'
};
```

4. **Guarda el archivo**

5. **Recarga la extension** en `chrome://extensions` (click en el icono de refresh)

---

## Uso de la Extension

### 1. Unete a una reunion

Abre una reunion en cualquiera de las plataformas soportadas:
- `meet.google.com/*`
- `*.zoom.us/*`
- `teams.microsoft.com/*`
- `teams.live.com/*`

### 2. Activa los subtitulos/captions

**Google Meet:**
- Click en los tres puntos (mas opciones)
- Selecciona "Turn on captions" o presiona `C`

**Zoom Web:**
- Click en "Live Transcript" en la barra inferior
- Selecciona "Show Subtitle" o "View Full Transcript"

**Microsoft Teams:**
- Click en los tres puntos (mas opciones)
- Selecciona "Turn on live captions"

### 3. Inicia la transcripcion

1. Click en el icono de la extension en la barra de Chrome
2. Veras el badge de la plataforma detectada (verde = listo)
3. Click en **"Start Transcription"**
4. El indicador cambiara a rojo pulsante y veras "Recording in progress..."

### 4. Durante la reunion

- La extension captura automaticamente los subtitulos
- Puedes ver el progreso en la consola de desarrollador (F12)
- El badge "REC" aparece en el icono de la extension

### 5. Detener y enviar

1. Click en **"Stop Transcription"**
2. Aparecera la seccion "Enviar Transcripcion"
3. (Opcional) Escribe el nombre de la empresa/persona
4. Revisa la vista previa de la transcripcion
5. Click en **"Enviar transcripcion"**
6. Recibiras el email en la direccion configurada

---

## Troubleshooting

### La extension no detecta la plataforma

- **Causa:** La URL no coincide con los patrones esperados
- **Solucion:** Asegurate de estar en la pagina de la reunion, no en el lobby o dashboard

### No se capturan subtitulos

- **Causa 1:** Los captions/subtitulos no estan activados en la reunion
- **Solucion:** Activa los subtitulos manualmente (ver seccion "Uso")

- **Causa 2:** Los selectores DOM cambiaron (las plataformas actualizan su UI)
- **Solucion:** Revisa la consola (F12) para ver errores. Los selectores estan en `content.js`

### El email no llega

- **Causa 1:** EmailJS no esta configurado correctamente
- **Solucion:** Verifica Service ID, Template ID, y Public Key en `background.js`

- **Causa 2:** Limite de emails gratuitos alcanzado
- **Solucion:** EmailJS gratuito permite 200 emails/mes. Revisa tu dashboard.

- **Causa 3:** El email llega a spam
- **Solucion:** Revisa la carpeta de spam y marca como "no es spam"

### Error "EmailJS no esta configurado"

- **Causa:** Los valores por defecto no fueron reemplazados
- **Solucion:** Edita `background.js` y reemplaza `YOUR_SERVICE_ID`, etc. con tus credenciales reales

### La transcripcion esta vacia

- **Causa:** Los captions no estaban activos cuando se inicio la grabacion
- **Solucion:** Activa los captions ANTES de iniciar la transcripcion, o reinicia

### Selectores desactualizados

Las plataformas (especialmente Google Meet) actualizan frecuentemente su interfaz. Si los subtitulos no se capturan:

1. Abre la reunion y activa captions
2. Abre DevTools (F12) > Elements
3. Inspecciona el elemento de caption
4. Actualiza los selectores en `content.js`:
   - `MeetCaptionCapture.SELECTORS` (linea ~24)
   - `ZoomCaptionCapture.SELECTORS` (linea ~656)
   - `TeamsCaptionCapture.SELECTORS` (linea ~1169)

---

## Estructura de Archivos

```
meeting-transcriber-extension/
├── manifest.json        # Configuracion de la extension Chrome
├── popup.html          # Interfaz del popup
├── popup.js            # Logica del popup (UI, estados)
├── background.js       # Service worker (estado, envio de emails)
├── content.js          # Script inyectado (captura de captions)
├── icons/
│   ├── icon16.png      # Icono 16x16
│   ├── icon48.png      # Icono 48x48
│   └── icon128.png     # Icono 128x128
├── README.md           # Este archivo
└── TESTING.md          # Guia de testing
```

### Descripcion de cada archivo

| Archivo | Funcion |
|---------|---------|
| `manifest.json` | Define permisos, hosts permitidos, scripts, iconos |
| `popup.html` | UI del popup con estilos CSS inline |
| `popup.js` | Maneja clicks, estados de grabacion, envio de email |
| `background.js` | Service worker: coordina mensajes, envia emails via EmailJS |
| `content.js` | Se inyecta en las paginas de reunion, observa el DOM para captions |

---

## Permisos requeridos

| Permiso | Uso |
|---------|-----|
| `activeTab` | Acceder a la tab actual |
| `storage` | Guardar estado de grabacion y transcripciones |
| `tabs` | Comunicacion con tabs de reuniones |
| `host_permissions` | Acceso a Meet, Zoom, Teams |

---

## Limitaciones conocidas

- Solo funciona con la version **web** de Zoom y Teams (no apps de escritorio)
- Requiere que los captions/subtitulos esten **activos** en la reunion
- Los selectores DOM pueden desactualizarse cuando las plataformas actualizan su UI
- EmailJS tiene limite de 200 emails/mes en plan gratuito

---

## Soporte

Si encuentras problemas:

1. Revisa la seccion de Troubleshooting
2. Abre la consola (F12) y busca errores con `[Meeting Transcriber]` o `[Meet Capture]`
3. Verifica que los captions estan activos en la reunion
