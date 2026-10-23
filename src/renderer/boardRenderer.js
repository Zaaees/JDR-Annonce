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

function hexToRgba(hex, alpha = 1) {
  const clean = String(hex || '#f59e0b').replace('#', '');
  if (clean.length !== 6) return `rgba(245, 158, 11, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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

    const sun = ctx.createRadialGradient(w * 0.78, h * 0.38, 5, w * 0.78, h * 0.38, 220);
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
    drawRidge(h * 0.62, 38, 'rgba(38, 19, 12, 0.85)', 1.2 + seed);
    drawRidge(h * 0.76, 30, '#1b0d08', 2.7 + seed);

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

    drawRidge(h * 0.88, 20, '#0d0705', 4.1 + seed);
  } else if (theme === 'cyberpunk') {
    const sky = ctx.createLinearGradient(0, 0, w, h);
    sky.addColorStop(0, '#060c17');
    sky.addColorStop(0.6, '#0b192c');
    sky.addColorStop(1, '#1a0b1e');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const glow = ctx.createRadialGradient(w * 0.74, h * 0.58, 10, w * 0.74, h * 0.58, 260);
    glow.addColorStop(0, 'rgba(14, 165, 233, 0.32)');
    glow.addColorStop(0.5, 'rgba(217, 70, 239, 0.15)');
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    const buildings = [
      { x: 460, y: 25, bw: 65, bh: h, c: '#070d17' },
      { x: 535, y: 12, bw: 82, bh: h, c: '#050911' },
      { x: 625, y: 40, bw: 58, bh: h, c: '#08101c' },
      { x: 690, y: 8, bw: 95, bh: h, c: '#04080f' },
      { x: 795, y: 30, bw: 70, bh: h, c: '#070d17' },
      { x: 875, y: 18, bw: 90, bh: h, c: '#050911' }
    ];
    buildings.forEach((b, idx) => {
      ctx.fillStyle = b.c;
      ctx.fillRect(b.x, b.y, b.bw, b.bh);
      for (let wy = b.y + 12; wy < h - 12; wy += 10) {
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

    const moonGlow = ctx.createRadialGradient(w * 0.8, h * 0.32, 12, w * 0.8, h * 0.32, 150);
    moonGlow.addColorStop(0, 'rgba(226, 232, 240, 0.55)');
    moonGlow.addColorStop(0.3, 'rgba(148, 163, 184, 0.18)');
    moonGlow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = moonGlow;
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(241, 245, 249, 0.75)';
    ctx.beginPath();
    ctx.arc(w * 0.8, h * 0.32, 24, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#070a0d';
    ctx.fillRect(620, 85, 95, 160);
    ctx.beginPath();
    ctx.moveTo(612, 85);
    ctx.lineTo(667, 35);
    ctx.lineTo(722, 85);
    ctx.fill();
    ctx.fillStyle = 'rgba(253, 224, 71, 0.65)';
    ctx.fillRect(662, 102, 8, 14);
    ctx.fillRect(674, 102, 8, 14);
  } else {
    const sky = ctx.createLinearGradient(0, 0, w, h);
    sky.addColorStop(0, '#14090d');
    sky.addColorStop(0.5, '#261019');
    sky.addColorStop(1, '#0b0a0e');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    const bloodMoon = ctx.createRadialGradient(w * 0.77, h * 0.33, 10, w * 0.77, h * 0.33, 180);
    bloodMoon.addColorStop(0, 'rgba(225, 29, 72, 0.45)');
    bloodMoon.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = bloodMoon;
    ctx.fillRect(0, 0, w, h);

    ctx.fillStyle = '#090608';
    ctx.fillRect(660, 65, 85, 195);
    ctx.beginPath();
    ctx.moveTo(655, 65);
    ctx.lineTo(680, 14);
    ctx.lineTo(705, 65);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(700, 65);
    ctx.lineTo(725, 14);
    ctx.lineTo(750, 65);
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
 * Génère le Buffer PNG du Méga-Dashboard en combinant :
 * - Concept 1 : Fond 100 % transparent entre les cartes, grand espacement (52px), cadre & liseré gauche à la couleur du @Rôle
 * - Concept 2 : Carte en 2 étages (Bannière illustrée 100 % dégagée en haut + Tiroir calendrier dédié en bas)
 */
const CARD_W = 1000;
const BANNER_H = 225; // Étage 1 : Bannière pure
const DRAWER_H = 165; // Étage 2 : Tiroir calendrier sous la bannière
const CARD_H = BANNER_H + DRAWER_H;

async function renderDashboardBuffer(enrichedCampaigns) {
  const width = CARD_W;
  const cardH = CARD_H;
  const gap = 52; // Grand espace transparent entre chaque JDR
  const pad = 12;

  if (!enrichedCampaigns || enrichedCampaigns.length === 0) {
    const emptyCanvas = createCanvas(width, 160);
    const ctx = emptyCanvas.getContext('2d');
    ctx.clearRect(0, 0, width, 160);
    roundRect(ctx, 12, 12, width - 24, 136, 14);
    ctx.fillStyle = '#111318';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.font = '700 24px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Aucune table JDR active.', width / 2, 88);
    return emptyCanvas.toBuffer('image/png');
  }

  await preloadCampaignAssets(enrichedCampaigns);

  const totalH = pad * 2 + enrichedCampaigns.length * cardH + (enrichedCampaigns.length - 1) * gap;
  const canvas = createCanvas(width, totalH);
  const ctx = canvas.getContext('2d');

  // Fond global 100 % transparent pour séparer visuellement chaque carte
  ctx.clearRect(0, 0, width, totalH);

  enrichedCampaigns.forEach((c, index) => {
    drawCampaignCard(ctx, c, index, pad, pad + index * (cardH + gap), width - pad * 2, true);
  });

  return canvas.toBuffer('image/png');
}

async function preloadCampaignAssets(campaigns) {
  await Promise.all(
    campaigns.map(async c => {
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
}

/**
 * Dessine une carte JDR complète (bannière en haut + tiroir calendrier en bas).
 */
function drawCampaignCard(ctx, c, index, x, y, w, h = CARD_H, withShadow = true) {
    const bannerH = BANNER_H;
    const drawerH = h - bannerH;
    const accentColor = c.roleColor || '#f59e0b';
    const weekDays = getWeekDaysFromMonday(c.weekMondayISO);
    const players = c.players || [];

    // Ombre portée externe sous la carte (uniquement en mode image empilée)
    ctx.save();
    if (withShadow) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.65)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 6;
    }
    roundRect(ctx, x, y, w, h, 16);
    ctx.fillStyle = '#0d0f14';
    ctx.fill();
    ctx.restore();

    ctx.save();
    roundRect(ctx, x, y, w, h, 16);
    ctx.clip();

    // =========================================================================
    // ÉTAGE 1 (HAUT) : BANNIÈRE ILLUSTRÉE 100 % DÉGAGÉE (hauteur = bannerH)
    // =========================================================================
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, bannerH);
    ctx.clip();

    if (c.bannerImg) {
      const imgRatio = c.bannerImg.width / c.bannerImg.height;
      const boxRatio = w / bannerH;
      let drawW = w;
      let drawH = bannerH;
      let offsetX = x;
      let offsetY = y;
      if (imgRatio > boxRatio) {
        drawW = bannerH * imgRatio;
        offsetX = x - (drawW - w) / 2;
      } else {
        drawH = w / imgRatio;
        offsetY = y - (drawH - bannerH) / 2;
      }
      ctx.drawImage(c.bannerImg, offsetX, offsetY, drawW, drawH);
    } else {
      drawProceduralArtwork(ctx, x, y, w, bannerH, c.theme || 'fantasy', index + 1);
    }

    // Léger dégradé latéral gauche uniquement derrière le titre et le badge MJ
    const leftGrad = ctx.createLinearGradient(x, y, x + w * 0.65, y);
    leftGrad.addColorStop(0, 'rgba(8, 10, 15, 0.78)');
    leftGrad.addColorStop(0.55, 'rgba(8, 10, 15, 0.25)');
    leftGrad.addColorStop(1, 'rgba(8, 10, 15, 0)');
    ctx.fillStyle = leftGrad;
    ctx.fillRect(x, y, w * 0.65, bannerH);

    // Léger fondu en bas de la bannière vers le tiroir
    const bannerBottomGrad = ctx.createLinearGradient(x, y + bannerH - 45, x, y + bannerH);
    bannerBottomGrad.addColorStop(0, 'rgba(13, 15, 20, 0)');
    bannerBottomGrad.addColorStop(1, 'rgba(13, 15, 20, 0.95)');
    ctx.fillStyle = bannerBottomGrad;
    ctx.fillRect(x, y + bannerH - 45, w, 45);

    // Titre du JDR en grand
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.95)';
    ctx.shadowBlur = 12;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 46px Georgia, serif';
    ctx.fillText(c.title, x + 32, y + 60);
    ctx.restore();

    // Badge @Rôle & MJ
    const roleLabel = c.roleName.startsWith('@') ? c.roleName : `@${c.roleName}`;
    const mjLabel = `MJ : ${c.mjName}`;
    ctx.font = '700 24px sans-serif';
    const roleWidth = ctx.measureText(roleLabel).width;
    const mjWidth = ctx.measureText(mjLabel).width;
    const badgeW = roleWidth + mjWidth + 58;

    roundRect(ctx, x + 32, y + 76, badgeW, 44, 10);
    ctx.fillStyle = 'rgba(10, 12, 18, 0.85)';
    ctx.fill();
    ctx.strokeStyle = hexToRgba(accentColor, 0.55);
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.fillStyle = accentColor;
    ctx.fillText(roleLabel, x + 46, y + 106);

    ctx.fillStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.fillText('·', x + 56 + roleWidth, y + 106);

    ctx.fillStyle = '#ffffff';
    ctx.fillText(mjLabel, x + 72 + roleWidth, y + 106);

    // Avatars des membres du @Rôle en haut à droite sur la bannière
    let curX = x + w - 28;
    for (let i = players.length - 1; i >= 0; i--) {
      const p = players[i];
      const isReady = c.status === 'confirmed' || p.voted;
      curX -= 25;
      drawPlayerToken(
        ctx,
        p,
        curX,
        y + 52,
        25,
        isReady ? '#10b981' : 'rgba(255,255,255,0.35)',
        isReady ? 1 : 0.55
      );
      curX -= 34;
    }

    ctx.restore();

    // =========================================================================
    // ÉTAGE 2 (BAS) : TIROIR CALENDRIER DÉDIÉ SOUS LA BANNIÈRE (hauteur = drawerH)
    // =========================================================================
    const drawerY = y + bannerH;
    ctx.fillStyle = '#0e1017';
    ctx.fillRect(x, drawerY, w, drawerH);

    // Ligne de séparation lumineuse à la couleur du @Rôle entre la bannière et le tiroir
    ctx.fillStyle = hexToRgba(accentColor, 0.75);
    ctx.fillRect(x, drawerY, w, 3);

    if (c.status === 'confirmed' && c.confirmedDateISO) {
      const fullDateStr = formatFullDateFR(c.confirmedDateISO).toUpperCase();

      roundRect(ctx, x + 28, drawerY + 18, w - 56, drawerH - 34, 12);
      ctx.fillStyle = 'rgba(16, 185, 129, 0.14)';
      ctx.fill();
      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#34d399';
      ctx.font = '800 20px sans-serif';
      ctx.fillText('PROCHAINE SESSION', x + 48, drawerY + 56);

      ctx.fillStyle = '#ffffff';
      ctx.font = '900 40px sans-serif';
      const sessionLabel = c.time ? `${fullDateStr}  —  ${c.time}` : fullDateStr;
      ctx.fillText(sessionLabel, x + 48, drawerY + 112, w - 96);
    } else if (c.status === 'paused') {
      roundRect(ctx, x + 28, drawerY + 18, w - 56, drawerH - 34, 12);
      ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(245, 158, 11, 0.65)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#f59e0b';
      ctx.font = '800 20px sans-serif';
      ctx.fillText('STATUT DE LA TABLE', x + 48, drawerY + 56);

      ctx.fillStyle = '#ffffff';
      ctx.font = '900 38px sans-serif';
      ctx.fillText('Table en pause', x + 48, drawerY + 108);
    } else if (c.status === 'prep') {
      roundRect(ctx, x + 28, drawerY + 18, w - 56, drawerH - 34, 12);
      ctx.fillStyle = 'rgba(99, 102, 241, 0.14)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(129, 140, 248, 0.65)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#818cf8';
      ctx.font = '800 20px sans-serif';
      ctx.fillText('STATUT DU MAÎTRE DU JEU', x + 48, drawerY + 56);

      ctx.fillStyle = '#ffffff';
      ctx.font = '900 38px sans-serif';
      ctx.fillText('Préparation MJ en cours', x + 48, drawerY + 108);
    } else if (c.status === 'unavailable' && c.unavailableUntilISO) {
      const untilStr = formatDayMonthFR(c.unavailableUntilISO);

      roundRect(ctx, x + 28, drawerY + 18, w - 56, drawerH - 34, 12);
      ctx.fillStyle = 'rgba(244, 63, 94, 0.14)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(244, 63, 94, 0.65)';
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.fillStyle = '#fda4af';
      ctx.font = '800 32px sans-serif';
      ctx.fillText(`Joueurs non disponibles jusqu'au ${untilStr}.`, x + 48, drawerY + 96);
    } else {
      // Grille des 7 jours dans le tiroir inférieur
      const gridX = x + 28;
      const gridY = drawerY + 16;
      const gridW = w - 56;
      const colGap = 8;
      const colW = (gridW - colGap * 6) / 7;
      const colH = drawerH - 30;

      weekDays.forEach((d, dayIdx) => {
        const cx = gridX + dayIdx * (colW + colGap);
        const availPlayers = players.filter(p => p.voted && p.days.includes(dayIdx));
        const isFull = availPlayers.length === players.length && players.length > 0;

        roundRect(ctx, cx, gridY, colW, colH, 10);
        ctx.fillStyle = isFull ? 'rgba(16, 185, 129, 0.28)' : '#161922';
        ctx.fill();
        ctx.strokeStyle = isFull ? '#34d399' : 'rgba(255, 255, 255, 0.14)';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = isFull ? '#34d399' : '#ffffff';
        ctx.font = '800 23px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${d.code} ${d.dayNum}`, cx + colW / 2, gridY + 32);

        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.beginPath();
        ctx.moveTo(cx + 10, gridY + 44);
        ctx.lineTo(cx + colW - 10, gridY + 44);
        ctx.stroke();

        if (availPlayers.length === 0) {
          ctx.fillStyle = 'rgba(255,255,255,0.25)';
          ctx.font = '700 16px sans-serif';
          ctx.fillText('—', cx + colW / 2, gridY + 96);
        } else {
          const r = 21;
          const spacing = Math.min(28, (colW - 38) / Math.max(1, availPlayers.length - 1));
          const totalRowW = (availPlayers.length - 1) * spacing;
          const startAvX = cx + colW / 2 - totalRowW / 2;

          availPlayers.forEach((p, idx) => {
            drawPlayerToken(ctx, p, startAvX + idx * spacing, gridY + 90, r, accentColor, 1);
          });
        }
        ctx.textAlign = 'left';
      });
    }

    ctx.restore();

    // Cadre extérieur coloré à la couleur du @Rôle
    roundRect(ctx, x, y, w, h, 16);
    ctx.strokeStyle = hexToRgba(accentColor, 0.9);
    ctx.lineWidth = 3;
    ctx.stroke();
}

/**
 * Génère l'image PNG d'une seule table JDR (format bannière large),
 * pour qu'elle soit affichée en grand dans la galerie du message Discord.
 */
async function renderCampaignCardBuffer(campaign, index = 0) {
  await preloadCampaignAssets([campaign]);
  const canvas = createCanvas(CARD_W, CARD_H);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, CARD_W, CARD_H);
  const pad = 3;
  drawCampaignCard(ctx, campaign, index, pad, pad, CARD_W - pad * 2, CARD_H - pad * 2, false);
  return canvas.toBuffer('image/png');
}

module.exports = {
  renderDashboardBuffer,
  renderCampaignCardBuffer
};
