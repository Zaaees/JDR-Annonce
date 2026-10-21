const { createCanvas, loadImage } = require('@napi-rs/canvas');
const {
  getWeekDaysFromMonday,
  formatFullDateFR,
  formatDayMonthFR
} = require('../utils/dates');

const imageCache = new Map();

async function fetchCachedImage(urlOrPath) {
  if (!urlOrPath) return null;
  if (imageCache.has(urlOrPath)) {
    return imageCache.get(urlOrPath);
  }
  try {
    const img = await loadImage(urlOrPath);
    if (imageCache.size > 200) {
      const firstKey = imageCache.keys().next().value;
      imageCache.delete(firstKey);
    }
    imageCache.set(urlOrPath, img);
    return img;
  } catch {
    return null;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawProceduralArtwork(ctx, x, y, w, h, theme = 'fantasy', seed = 1) {
  ctx.save();
  ctx.translate(x, y);

  if (theme === 'fantasy') {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#1a0f0a');
    sky.addColorStop(0.5, '#432010');
    sky.addColorStop(1, '#120906');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const sun = ctx.createRadialGradient(w * 0.78, h * 0.35, 5, w * 0.78, h * 0.35, 220);
    sun.addColorStop(0, 'rgba(255, 190, 90, 0.75)');
    sun.addColorStop(0.35, 'rgba(210, 95, 30, 0.35)');
    sun.addColorStop(1, 'rgba(20, 10, 5, 0)');
    ctx.fillStyle = sun;
    ctx.fillRect(0, 0, w, h);

    const drawRidge = (baseY, amp, color, detailSeed) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, h);
      for (let px = 0; px <= w; px += 20) {
        const py = baseY
          - Math.sin(px * 0.006 + detailSeed) * amp
          - Math.cos(px * 0.019 - detailSeed) * (amp * 0.45)
          - Math.sin(px * 0.05) * 8;
        ctx.lineTo(px, py);
      }
      ctx.lineTo(w, h);
      ctx.closePath();
      ctx.fill();
    };
    drawRidge(h * 0.62, 42, 'rgba(38, 19, 12, 0.85)', 1.2 + seed);
    drawRidge(h * 0.74, 35, '#1b0d08', 2.7 + seed);

    // Silhouette de citadelle
    ctx.fillStyle = '#120805';
    ctx.fillRect(w * 0.68, h * 0.36, 38, 70);
    ctx.fillRect(w * 0.72, h * 0.28, 24, 88);
    ctx.beginPath();
    ctx.moveTo(w * 0.716, h * 0.28);
    ctx.lineTo(w * 0.732, h * 0.14);
    ctx.lineTo(w * 0.748, h * 0.28);
    ctx.fill();
    ctx.fillStyle = '#fbbf24';
    ctx.fillRect(w * 0.73, h * 0.35, 4, 10);

    drawRidge(h * 0.86, 22, '#0d0705', 4.1 + seed);
  } else if (theme === 'cyberpunk') {
    const sky = ctx.createLinearGradient(0, 0, w, h);
    sky.addColorStop(0, '#060c17');
    sky.addColorStop(0.6, '#0b192c');
    sky.addColorStop(1, '#1a0b1e');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const glow = ctx.createRadialGradient(w * 0.74, h * 0.58, 10, w * 0.74, h * 0.58, 280);
    glow.addColorStop(0, 'rgba(14, 165, 233, 0.32)');
    glow.addColorStop(0.5, 'rgba(217, 70, 239, 0.15)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    const buildings = [
      { x: 460, y: 35, bw: 65, bh: 205, c: '#070d17' },
      { x: 535, y: 18, bw: 82, bh: 222, c: '#050911' },
      { x: 625, y: 52, bw: 58, bh: 188, c: '#08101c' },
      { x: 690, y: 12, bw: 95, bh: 228, c: '#04080f' },
      { x: 795, y: 40, bw: 70, bh: 200, c: '#070d17' },
      { x: 875, y: 24, bw: 90, bh: 216, c: '#050911' }
    ];
    buildings.forEach((b, idx) => {
      ctx.fillStyle = b.c;
      ctx.fillRect(b.x, b.y, b.bw, b.bh);
      for (let wy = b.y + 12; wy < h - 15; wy += 10) {
        for (let wx = b.x + 8; wx < b.x + b.bw - 12; wx += 14) {
          if ((wx * wy + idx) % 5 === 0) {
            ctx.fillStyle = (wx + wy) % 7 === 0 ? 'rgba(244, 63, 94, 0.55)' : 'rgba(56, 189, 248, 0.45)';
            ctx.fillRect(wx, wy, 8, 3);
          }
        }
      }
    });
  } else if (theme === 'horror') {
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#090d12');
    sky.addColorStop(0.65, '#131d24');
    sky.addColorStop(1, '#080b0e');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const moonGlow = ctx.createRadialGradient(w * 0.8, h * 0.3, 12, w * 0.8, h * 0.3, 160);
    moonGlow.addColorStop(0, 'rgba(226, 232, 240, 0.55)');
    moonGlow.addColorStop(0.3, 'rgba(148, 163, 184, 0.18)');
    moonGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = moonGlow;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(241, 245, 249, 0.75)';
    ctx.beginPath();
    ctx.arc(w * 0.8, h * 0.3, 24, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#070a0d';
    ctx.fillRect(620, 95, 95, 120);
    ctx.beginPath();
    ctx.moveTo(612, 95);
    ctx.lineTo(667, 45);
    ctx.lineTo(722, 95);
    ctx.fill();
    ctx.fillStyle = 'rgba(253, 224, 71, 0.65)';
    ctx.fillRect(662, 112, 8, 14);
    ctx.fillRect(674, 112, 8, 14);
  } else {
    const sky = ctx.createLinearGradient(0, 0, w, h);
    sky.addColorStop(0, '#14090d');
    sky.addColorStop(0.5, '#261019');
    sky.addColorStop(1, '#0b0a0e');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const bloodMoon = ctx.createRadialGradient(w * 0.77, h * 0.33, 10, w * 0.77, h * 0.33, 190);
    bloodMoon.addColorStop(0, 'rgba(225, 29, 72, 0.45)');
    bloodMoon.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bloodMoon;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#090608';
    ctx.fillRect(660, 75, 85, 165);
    ctx.beginPath();
    ctx.moveTo(655, 75);
    ctx.lineTo(680, 18);
    ctx.lineTo(705, 75);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(700, 75);
    ctx.lineTo(725, 18);
    ctx.lineTo(750, 75);
    ctx.fill();
  }

  ctx.restore();
}

function drawPlayerToken(ctx, player, cx, cy, radius, borderColor, alpha = 1) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();

  if (player.avatarImg) {
    ctx.drawImage(player.avatarImg, cx - radius, cy - radius, radius * 2, radius * 2);
  } else {
    // Fallback silhouette propre si l'avatar Discord n'a pas pu être chargé
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
    ctx.fillStyle = '#94a3b8';
    ctx.beginPath();
    ctx.arc(cx, cy - radius * 0.2, radius * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy + radius * 0.85, radius * 0.65, Math.PI, 0, false);
    ctx.fill();
  }
  ctx.restore();

  if (borderColor) {
    ctx.save();
    ctx.strokeStyle = borderColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Génère le Buffer PNG du Méga-Dashboard regroupant toutes les campagnes JDR.
 * @param {Array} enrichedCampaigns - Campagnes enrichies avec `players: [{ id, name, avatarUrl, voted, days }]`
 * @returns {Promise<Buffer>}
 */
async function renderDashboardBuffer(enrichedCampaigns) {
  const width = 1000;
  const cardH = 290;
  const gap = 20;
  const pad = 24;

  if (!enrichedCampaigns || enrichedCampaigns.length === 0) {
    const emptyCanvas = createCanvas(width, 180);
    const ctx = emptyCanvas.getContext('2d');
    ctx.fillStyle = '#090a0d';
    ctx.fillRect(0, 0, width, 180);
    roundRect(ctx, 24, 24, width - 48, 132, 12);
    ctx.fillStyle = '#111318';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '600 20px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Aucune table JDR active.', width / 2, 96);
    return emptyCanvas.toBuffer('image/png');
  }

  // Pré-chargement parallèle des bannières personnalisées et des avatars Discord
  await Promise.all(
    enrichedCampaigns.map(async c => {
      if (c.bannerUrl) {
        c.bannerImg = await fetchCachedImage(c.bannerUrl);
      }
      if (Array.isArray(c.players)) {
        await Promise.all(
          c.players.map(async p => {
            if (p.avatarUrl) {
              p.avatarImg = await fetchCachedImage(p.avatarUrl);
            }
          })
        );
      }
    })
  );

  const totalH = pad * 2 + enrichedCampaigns.length * cardH + (enrichedCampaigns.length - 1) * gap;
  const canvas = createCanvas(width, totalH);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#090a0d';
  ctx.fillRect(0, 0, width, totalH);

  enrichedCampaigns.forEach((c, index) => {
    const x = pad;
    const y = pad + index * (cardH + gap);
    const w = width - pad * 2;
    const h = cardH;
    const weekDays = getWeekDaysFromMonday(c.weekMondayISO);
    const players = c.players || [];

    ctx.save();
    roundRect(ctx, x, y, w, h, 12);
    ctx.clip();

    // 1. Bannière de fond (Image personnalisée du MJ OU scène peinte procédurale)
    if (c.bannerImg) {
      const imgRatio = c.bannerImg.width / c.bannerImg.height;
      const boxRatio = w / h;
      let drawW = w;
      let drawH = h;
      let offsetX = x;
      let offsetY = y;
      const fit = c.bannerFit || 'center';

      if (imgRatio > boxRatio) {
        drawW = h * imgRatio;
        if (fit === 'left') {
          offsetX = x;
        } else if (fit === 'right') {
          offsetX = x - (drawW - w);
        } else {
          offsetX = x - (drawW - w) / 2;
        }
      } else {
        drawH = w / imgRatio;
        if (fit === 'top') {
          offsetY = y;
        } else if (fit === 'bottom') {
          offsetY = y - (drawH - h);
        } else {
          offsetY = y - (drawH - h) / 2;
        }
      }
      ctx.drawImage(c.bannerImg, offsetX, offsetY, drawW, drawH);
    } else {
      drawProceduralArtwork(ctx, x, y, w, h, c.theme || 'fantasy', index + 1);
    }

    // 2. Fondus légers pour faire ressortir l'image tout en assurant la lisibilité du texte
    // Dégradé sombre doux uniquement en haut (derrière titre et avatars) et en bas (derrière les cases)
    const topGrad = ctx.createLinearGradient(x, y, x, y + 90);
    topGrad.addColorStop(0, 'rgba(10, 11, 15, 0.75)');
    topGrad.addColorStop(1, 'rgba(10, 11, 15, 0.05)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(x, y, w, 90);

    const bottomGrad = ctx.createLinearGradient(x, y + h - 160, x, y + h);
    bottomGrad.addColorStop(0, 'rgba(10, 11, 15, 0.1)');
    bottomGrad.addColorStop(1, 'rgba(10, 11, 15, 0.85)');
    ctx.fillStyle = bottomGrad;
    ctx.fillRect(x, y + h - 160, w, 160);

    // 3. Titre du JDR + @Rôle Discord + MJ
    ctx.fillStyle = '#ffffff';
    ctx.font = '800 24px Georgia, serif';
    ctx.fillText(c.title, x + 24, y + 40);

    ctx.font = '600 13px sans-serif';
    ctx.fillStyle = c.roleColor || '#f59e0b';
    const roleLabel = c.roleName.startsWith('@') ? c.roleName : `@${c.roleName}`;
    ctx.fillText(`${roleLabel}  ·  MJ ${c.mjName}`, x + 24, y + 62);

    // Avatars des membres du @Rôle en haut à droite
    let curX = x + w - 24;
    for (let i = players.length - 1; i >= 0; i--) {
      const p = players[i];
      const isReady = c.status === 'confirmed' || p.voted;
      curX -= 18;
      drawPlayerToken(
        ctx,
        p,
        curX,
        y + 38,
        18,
        isReady ? '#10b981' : 'rgba(255,255,255,0.2)',
        isReady ? 1 : 0.45
      );
      curX -= 26;
    }

    // 4. Zone inférieure selon le statut ('confirmed' | 'unavailable' | 'poll')
    if (c.status === 'confirmed' && c.confirmedDateISO) {
      const fullDateStr = formatFullDateFR(c.confirmedDateISO).toUpperCase();

      roundRect(ctx, x + 24, y + 155, w - 48, 110, 10);
      ctx.fillStyle = 'rgba(16, 185, 129, 0.18)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(52, 211, 153, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#34d399';
      ctx.font = '700 13px sans-serif';
      ctx.fillText('PROCHAINE SESSION', x + 44, y + 190);

      ctx.fillStyle = '#ffffff';
      ctx.font = '800 30px sans-serif';
      ctx.fillText(`${fullDateStr}  —  ${c.time}`, x + 44, y + 234);

      let tokenX = x + w - 56;
      players.slice().reverse().forEach(p => {
        drawPlayerToken(ctx, p, tokenX, y + 210, 24, '#34d399', 1);
        tokenX -= 40;
      });
    } else if (c.status === 'unavailable' && c.unavailableUntilISO) {
      const untilStr = formatDayMonthFR(c.unavailableUntilISO);

      roundRect(ctx, x + 24, y + 155, w - 48, 110, 10);
      ctx.fillStyle = 'rgba(244, 63, 94, 0.18)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.5)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.fillStyle = '#fda4af';
      ctx.font = '700 24px sans-serif';
      ctx.fillText(`Joueurs non disponibles jusqu'au ${untilStr}.`, x + 44, y + 218);
    } else {
      // Sondage en cours : 7 colonnes (LUN .. DIM) avec les jetons des joueurs disponibles
      const gridX = x + 24;
      const gridY = y + 150;
      const gridW = w - 48;
      const colGap = 8;
      const colW = (gridW - colGap * 6) / 7;
      const colH = 116;

      weekDays.forEach((d, dayIdx) => {
        const cx = gridX + dayIdx * (colW + colGap);
        const availPlayers = players.filter(p => p.voted && p.days.includes(dayIdx));
        const isFull = availPlayers.length === players.length && players.length > 0;

        roundRect(ctx, cx, gridY, colW, colH, 8);
        ctx.fillStyle = isFull ? 'rgba(16, 185, 129, 0.28)' : 'rgba(17, 19, 25, 0.82)';
        ctx.fill();
        ctx.strokeStyle = isFull ? '#34d399' : 'rgba(255, 255, 255, 0.12)';
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = isFull ? '#34d399' : '#e2e8f0';
        ctx.font = '700 13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${d.code} ${d.dayNum}`, cx + colW / 2, gridY + 24);

        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.beginPath();
        ctx.moveTo(cx + 10, gridY + 34);
        ctx.lineTo(cx + colW - 10, gridY + 34);
        ctx.stroke();

        if (availPlayers.length === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.2)';
          ctx.font = '500 12px sans-serif';
          ctx.fillText('—', cx + colW / 2, gridY + 76);
        } else {
          const r = 15;
          const spacing = Math.min(26, (colW - 30) / Math.max(1, availPlayers.length - 1));
          const totalRowW = (availPlayers.length - 1) * spacing;
          const startAvX = cx + colW / 2 - totalRowW / 2;

          availPlayers.forEach((p, idx) => {
            drawPlayerToken(ctx, p, startAvX + idx * spacing, gridY + 72, r, '#38bdf8', 1);
          });
        }
        ctx.textAlign = 'left';
      });
    }

    roundRect(ctx, x, y, w, h, 12);
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  });

  return canvas.toBuffer('image/png');
}

module.exports = {
  renderDashboardBuffer
};
