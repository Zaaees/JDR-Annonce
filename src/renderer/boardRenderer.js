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

    const sun = ctx.createRadialGradient(w * 0.78, h * 0.35, 5, w * 0.78, h * 0.35, 240);
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
      { x: 460, y: 35, bw: 65, bh: 285, c: '#070d17' },
      { x: 535, y: 18, bw: 82, bh: 302, c: '#050911' },
      { x: 625, y: 52, bw: 58, bh: 268, c: '#08101c' },
      { x: 690, y: 12, bw: 95, bh: 308, c: '#04080f' },
      { x: 795, y: 40, bw: 70, bh: 280, c: '#070d17' },
      { x: 875, y: 24, bw: 90, bh: 296, c: '#050911' }
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
    ctx.fillRect(620, 95, 95, 160);
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
    ctx.fillRect(660, 75, 85, 205);
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
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
}

/**
 * Génère le Buffer PNG du Méga-Dashboard regroupant toutes les campagnes JDR.
 */
async function renderDashboardBuffer(enrichedCampaigns) {
  const width = 1000;
  const cardH = 330;
  const gap = 22;
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
    ctx.font = '700 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Aucune table JDR active.', width / 2, 98);
    return emptyCanvas.toBuffer('image/png');
  }

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
    roundRect(ctx, x, y, w, h, 14);
    ctx.clip();

    // 1. Bannière de fond
    if (c.bannerImg) {
      const imgRatio = c.bannerImg.width / c.bannerImg.height;
      const boxRatio = w / h;
      let drawW = w;
      let drawH = h;
      let offsetX = x;
      let offsetY = y;
      if (imgRatio > boxRatio) {
        drawW = h * imgRatio;
        offsetX = x - (drawW - w) / 2;
      } else {
        drawH = w / imgRatio;
        offsetY = y - (drawH - h) / 2;
      }
      ctx.drawImage(c.bannerImg, offsetX, offsetY, drawW, drawH);
    } else {
      drawProceduralArtwork(ctx, x, y, w, h, c.theme || 'fantasy', index + 1);
    }

    // 2. Fondus ciblés en haut et en bas pour conserver la visibilité de la bannière
    const topGrad = ctx.createLinearGradient(x, y, x, y + 115);
    topGrad.addColorStop(0, 'rgba(8, 9, 13, 0.85)');
    topGrad.addColorStop(0.7, 'rgba(8, 9, 13, 0.45)');
    topGrad.addColorStop(1, 'rgba(8, 9, 13, 0)');
    ctx.fillStyle = topGrad;
    ctx.fillRect(x, y, w, 115);

    const bottomGrad = ctx.createLinearGradient(x, y + h - 180, x, y + h);
    bottomGrad.addColorStop(0, 'rgba(8, 9, 13, 0)');
    bottomGrad.addColorStop(0.35, 'rgba(8, 9, 13, 0.65)');
    bottomGrad.addColorStop(1, 'rgba(8, 9, 13, 0.92)');
    ctx.fillStyle = bottomGrad;
    ctx.fillRect(x, y + h - 180, w, 180);

    // 3. Titre du JDR grand format + Ombre portée franche
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 2;
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 36px Georgia, serif';
    ctx.fillText(c.title, x + 26, y + 48);
    ctx.restore();

    // Badge lisible pour @Rôle et MJ
    const roleLabel = c.roleName.startsWith('@') ? c.roleName : `@${c.roleName}`;
    const mjLabel = `MJ : ${c.mjName}`;
    ctx.font = '700 19px sans-serif';
    const roleWidth = ctx.measureText(roleLabel).width;
    const mjWidth = ctx.measureText(mjLabel).width;
    const badgeW = roleWidth + mjWidth + 46;

    roundRect(ctx, x + 26, y + 62, badgeW, 34, 8);
    ctx.fillStyle = 'rgba(10, 12, 18, 0.78)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = c.roleColor || '#fbbf24';
    ctx.fillText(roleLabel, x + 38, y + 85);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.fillText('·', x + 46 + roleWidth, y + 85);

    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(mjLabel, x + 58 + roleWidth, y + 85);

    // Avatars des membres du @Rôle en haut à droite (plus grands : rayon 23px)
    let curX = x + w - 26;
    for (let i = players.length - 1; i >= 0; i--) {
      const p = players[i];
      const isReady = c.status === 'confirmed' || p.voted;
      curX -= 23;
      drawPlayerToken(
        ctx,
        p,
        curX,
        y + 48,
        23,
        isReady ? '#10b981' : 'rgba(255,255,255,0.28)',
        isReady ? 1 : 0.5
      );
      curX -= 32;
    }

    // 4. Zone inférieure selon le statut ('confirmed' | 'unavailable' | 'poll')
    if (c.status === 'confirmed' && c.confirmedDateISO) {
      const fullDateStr = formatFullDateFR(c.confirmedDateISO).toUpperCase();

      roundRect(ctx, x + 24, y + 182, w - 48, 124, 12);
      ctx.fillStyle = 'rgba(10, 22, 18, 0.85)';
      ctx.fill();
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#34d399';
      ctx.font = '800 16px sans-serif';
      ctx.fillText('PROCHAINE SESSION', x + 44, y + 218);

      ctx.fillStyle = '#ffffff';
      ctx.font = '900 34px sans-serif';
      ctx.fillText(`${fullDateStr}  —  ${c.time}`, x + 44, y + 268);

      let tokenX = x + w - 60;
      players.slice().reverse().forEach(p => {
        drawPlayerToken(ctx, p, tokenX, y + 244, 26, '#34d399', 1);
        tokenX -= 44;
      });
    } else if (c.status === 'unavailable' && c.unavailableUntilISO) {
      const untilStr = formatDayMonthFR(c.unavailableUntilISO);

      roundRect(ctx, x + 24, y + 182, w - 48, 124, 12);
      ctx.fillStyle = 'rgba(28, 10, 16, 0.85)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.65)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#fda4af';
      ctx.font = '800 28px sans-serif';
      ctx.fillText(`Joueurs non disponibles jusqu'au ${untilStr}.`, x + 44, y + 254);
    } else {
      // Sondage en cours : 7 colonnes (LUN .. DIM) très lisibles
      const gridX = x + 24;
      const gridY = y + 174;
      const gridW = w - 48;
      const colGap = 8;
      const colW = (gridW - colGap * 6) / 7;
      const colH = 132;

      weekDays.forEach((d, dayIdx) => {
        const cx = gridX + dayIdx * (colW + colGap);
        const availPlayers = players.filter(p => p.voted && p.days.includes(dayIdx));
        const isFull = availPlayers.length === players.length && players.length > 0;

        roundRect(ctx, cx, gridY, colW, colH, 10);
        ctx.fillStyle = isFull ? 'rgba(16, 185, 129, 0.32)' : 'rgba(12, 14, 20, 0.88)';
        ctx.fill();
        ctx.strokeStyle = isFull ? '#34d399' : 'rgba(255, 255, 255, 0.18)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Nom du jour + Date en grand (19px)
        ctx.fillStyle = isFull ? '#34d399' : '#ffffff';
        ctx.font = '800 18px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${d.code} ${d.dayNum}`, cx + colW / 2, gridY + 28);

        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        ctx.moveTo(cx + 10, gridY + 40);
        ctx.lineTo(cx + colW - 10, gridY + 40);
        ctx.stroke();

        if (availPlayers.length === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.28)';
          ctx.font = '700 16px sans-serif';
          ctx.fillText('—', cx + colW / 2, gridY + 90);
        } else {
          const r = 19;
          const spacing = Math.min(28, (colW - 38) / Math.max(1, availPlayers.length - 1));
          const totalRowW = (availPlayers.length - 1) * spacing;
          const startAvX = cx + colW / 2 - totalRowW / 2;

          availPlayers.forEach((p, idx) => {
            drawPlayerToken(ctx, p, startAvX + idx * spacing, gridY + 84, r, '#38bdf8', 1);
          });
        }
        ctx.textAlign = 'left';
      });
    }

    roundRect(ctx, x, y, w, h, 14);
    ctx.strokeStyle = 'rgba(255,255,255,0.18)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();
  });

  return canvas.toBuffer('image/png');
}

module.exports = {
  renderDashboardBuffer
};
