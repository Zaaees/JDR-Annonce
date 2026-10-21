const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { updateCampaignConfig } = require('../storage/store');
const { refreshDashboardMessage } = require('../bot/dashboardManager');

const UPLOADS_DIR = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Tokens temporaires pour sécuriser l'accès au recadrage
// Map<token, { guildId, campaignId, imageUrl, expiresAt }>
const cropSessions = new Map();

function createCropSession(guildId, campaignId, imageUrl) {
  const token = crypto.randomBytes(16).toString('hex');
  cropSessions.set(token, {
    guildId,
    campaignId,
    imageUrl,
    expiresAt: Date.now() + 30 * 60 * 1000 // 30 minutes
  });
  return token;
}

function getCropHtml(session, token) {
  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Recadrer la bannière JDR</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0f1115; color: #e6e8eb; padding: 20px; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #181a20; border: 1px solid #2b2f3a; border-radius: 12px; padding: 24px; max-width: 840px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 8px; color: #fff; }
    p { font-size: 14px; color: #9aa0a6; margin-bottom: 20px; }
    .crop-wrapper { position: relative; width: 100%; height: 232px; background: #090a0d; border-radius: 8px; overflow: hidden; border: 2px dashed #3b4252; cursor: grab; user-select: none; }
    .crop-wrapper:active { cursor: grabbing; }
    #preview-img { position: absolute; pointer-events: none; transform-origin: 0 0; }
    .controls { margin-top: 20px; display: flex; flex-direction: column; gap: 14px; }
    .zoom-row { display: flex; align-items: center; gap: 12px; font-size: 14px; color: #c4c9d4; }
    .zoom-row input[type=range] { flex: 1; accent-color: #5865f2; }
    .actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px; }
    button { background: #5865f2; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; transition: 0.15s; }
    button:hover { background: #4752c4; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .badge { display: inline-block; padding: 2px 8px; background: rgba(88,101,242,0.15); border: 1px solid rgba(88,101,242,0.3); border-radius: 4px; font-size: 12px; color: #8ea1e1; margin-bottom: 12px; }
    #status { margin-top: 10px; font-size: 13px; text-align: center; }
  </style>
</head>
<body>
  <div class="card">
    <span class="badge">Format 1000 x 290 px</span>
    <h1>Ajuster le cadrage de la bannière</h1>
    <p>Glisse l'image avec ta souris pour choisir la partie visible, ou ajuste le zoom ci-dessous.</p>
    
    <div class="crop-wrapper" id="cropBox">
      <img id="preview-img" src="${session.imageUrl}" crossorigin="anonymous" alt="Image">
    </div>

    <div class="controls">
      <div class="zoom-row">
        <span>Zoom :</span>
        <input type="range" id="zoomSlider" min="1" max="3" step="0.01" value="1">
        <span id="zoomVal">100%</span>
      </div>
      <div class="actions">
        <button id="saveBtn">Enregistrer et appliquer</button>
      </div>
      <div id="status"></div>
    </div>
  </div>

  <canvas id="exportCanvas" width="1000" height="290" style="display:none;"></canvas>

  <script>
    const box = document.getElementById('cropBox');
    const img = document.getElementById('preview-img');
    const slider = document.getElementById('zoomSlider');
    const zoomVal = document.getElementById('zoomVal');
    const saveBtn = document.getElementById('saveBtn');
    const statusDiv = document.getElementById('status');
    const canvas = document.getElementById('exportCanvas');
    const ctx = canvas.getContext('2d');

    let baseScale = 1;
    let currentZoom = 1;
    let posX = 0;
    let posY = 0;
    let isDragging = false;
    let startX = 0;
    let startY = 0;

    img.onload = () => {
      const boxW = box.clientWidth;
      const boxH = box.clientHeight;
      const scaleX = boxW / img.naturalWidth;
      const scaleY = boxH / img.naturalHeight;
      baseScale = Math.max(scaleX, scaleY);
      
      posX = (boxW - img.naturalWidth * baseScale) / 2;
      posY = (boxH - img.naturalHeight * baseScale) / 2;
      updateTransform();
    };

    function updateTransform() {
      const effectiveScale = baseScale * currentZoom;
      const boxW = box.clientWidth;
      const boxH = box.clientHeight;
      const renderedW = img.naturalWidth * effectiveScale;
      const renderedH = img.naturalHeight * effectiveScale;

      const minX = boxW - renderedW;
      const minY = boxH - renderedH;
      posX = Math.min(0, Math.max(minX, posX));
      posY = Math.min(0, Math.max(minY, posY));

      img.style.width = (img.naturalWidth * effectiveScale) + 'px';
      img.style.height = (img.naturalHeight * effectiveScale) + 'px';
      img.style.left = posX + 'px';
      img.style.top = posY + 'px';
    }

    slider.addEventListener('input', (e) => {
      currentZoom = parseFloat(e.target.value);
      zoomVal.textContent = Math.round(currentZoom * 100) + '%';
      updateTransform();
    });

    box.addEventListener('mousedown', (e) => {
      isDragging = true;
      startX = e.clientX - posX;
      startY = e.clientY - posY;
    });

    window.addEventListener('mousemove', (e) => {
      if (!isDragging) return;
      posX = e.clientX - startX;
      posY = e.clientY - startY;
      updateTransform();
    });

    window.addEventListener('mouseup', () => { isDragging = false; });

    box.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        isDragging = true;
        startX = e.touches[0].clientX - posX;
        startY = e.touches[0].clientY - posY;
      }
    });

    window.addEventListener('touchmove', (e) => {
      if (!isDragging || e.touches.length !== 1) return;
      posX = e.touches[0].clientX - startX;
      posY = e.touches[0].clientY - startY;
      updateTransform();
    });

    window.addEventListener('touchend', () => { isDragging = false; });

    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      statusDiv.style.color = '#8ea1e1';
      statusDiv.textContent = 'Recadrage et envoi en cours...';

      const boxW = box.clientWidth;
      const boxH = box.clientHeight;
      const effectiveScale = baseScale * currentZoom;
      const scaleTo1000 = 1000 / boxW;

      ctx.drawImage(
        img,
        posX * scaleTo1000,
        posY * scaleTo1000,
        (img.naturalWidth * effectiveScale) * scaleTo1000,
        (img.naturalHeight * effectiveScale) * scaleTo1000
      );

      const base64Png = canvas.toDataURL('image/png');

      try {
        const res = await fetch('/crop/' + '${token}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imageBase64: base64Png })
        });

        if (res.ok) {
          statusDiv.style.color = '#34d399';
          statusDiv.textContent = 'Bannière mise à jour avec succès ! Tu peux fermer cette page et retourner sur Discord.';
        } else {
          throw new Error();
        }
      } catch (err) {
        statusDiv.style.color = '#f87171';
        statusDiv.textContent = 'Erreur lors de la mise à jour. Réessaie ou relance la commande sur Discord.';
        saveBtn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function handleCropHttp(req, res, client) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 1. Servir la page HTML du crop : GET /crop/:token
  if (req.method === 'GET' && url.pathname.startsWith('/crop/')) {
    const token = url.pathname.split('/crop/')[1];
    const session = cropSessions.get(token);

    if (!session || Date.now() > session.expiresAt) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>Lien de recadrage expiré ou invalide.</h1><p>Relance la commande sur Discord.</p>');
      return true;
    }

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getCropHtml(session, token));
    return true;
  }

  // 2. Réception de l'image recadrée : POST /crop/:token
  if (req.method === 'POST' && url.pathname.startsWith('/crop/')) {
    const token = url.pathname.split('/crop/')[1];
    const session = cropSessions.get(token);

    if (!session || Date.now() > session.expiresAt) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session expirée' }));
      return true;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { imageBase64 } = JSON.parse(body);
        if (!imageBase64 || !imageBase64.startsWith('data:image/png;base64,')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Image invalide' }));
          return;
        }

        const buffer = Buffer.from(imageBase64.replace(/^data:image\/png;base64,/, ''), 'base64');
        let bannerUrl = imageBase64;
        if (client) {
          try {
            const { getGuildState } = require('../storage/store');
            const { guild: gData } = getGuildState(session.guildId);
            if (gData.channelId) {
              const channel = await client.channels.fetch(gData.channelId);
              if (channel) {
                const { AttachmentBuilder } = require('discord.js');
                const att = new AttachmentBuilder(buffer, { name: `banner_.png` });
                const storageMsg = await channel.send({ content: '[Bannière enregistrée]', files: [att] });
                bannerUrl = storageMsg.attachments.first().url;
              }
            }
          } catch (e) { console.error('Erreur hébergement Discord:', e); }
        }
        updateCampaignConfig(session.guildId, session.campaignId, { bannerUrl });
        cropSessions.delete(token);

        if (client) {
          await refreshDashboardMessage(client, session.guildId);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        console.error('Erreur sauvegarde crop:', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Erreur serveur' }));
      }
    });
    return true;
  }

  return false;
}

module.exports = {
  createCropSession,
  handleCropHttp
};
