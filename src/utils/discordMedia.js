/**
 * Gestion et rafraîchissement automatique des pièces jointes Discord expirables (CDN discordapp.com).
 * Depuis fin 2023, toute URL Discord CDN attachments expire après 24 heures (?ex=...&is=...&hm=...).
 * Ce module garantit la persistance permanente des images (bannières de JDR) en rafraîchissant
 * automatiquement les URLs expirées et en les récupérant depuis les DMs.
 */

function isDiscordCdnUrl(url) {
  if (!url || typeof url !== 'string') return false;
  return url.includes('cdn.discordapp.com/attachments/') || url.includes('media.discordapp.net/attachments/');
}

function isDiscordUrlExpired(url) {
  if (!isDiscordCdnUrl(url)) return false;
  try {
    const parsed = new URL(url);
    const exHex = parsed.searchParams.get('ex');
    if (!exHex) {
      // Les URLs attachments sans paramètre ex sont rejetées par Discord
      return true;
    }
    const exTimestamp = parseInt(exHex, 16) * 1000;
    // Si l'URL expire dans moins de 10 minutes ou est déjà expirée
    return Date.now() >= (exTimestamp - 10 * 60 * 1000);
  } catch {
    return false;
  }
}

/**
 * Appelle l'endpoint officiel Discord POST /api/v10/attachments/refresh-urls
 */
async function refreshDiscordAttachmentUrls(urls) {
  if (!urls || urls.length === 0) return new Map();
  const validUrls = urls.filter(u => isDiscordCdnUrl(u));
  if (validUrls.length === 0) return new Map();

  const token = process.env.DISCORD_TOKEN;
  if (!token) return new Map();

  const resultMap = new Map();

  // Discord autorise jusqu'à 50 URLs par requête
  const batchSize = 50;
  for (let i = 0; i < validUrls.length; i += batchSize) {
    const batch = validUrls.slice(i, i + batchSize);
    try {
      const res = await fetch('https://discord.com/api/v10/attachments/refresh-urls', {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ attachment_urls: batch })
      });

      if (!res.ok) {
        console.warn(`[DiscordMedia] Échec refresh-urls (${res.status}):`, await res.text().catch(() => ''));
        continue;
      }

      const data = await res.json();
      if (data && Array.isArray(data.refreshed_urls)) {
        for (const item of data.refreshed_urls) {
          if (item.original && item.refreshed) {
            resultMap.set(item.original, item.refreshed);
          }
        }
      }
    } catch (err) {
      console.error('[DiscordMedia] Erreur requête refresh-urls:', err?.message);
    }
  }

  return resultMap;
}

/**
 * Rafraîchit une seule URL Discord CDN si besoin.
 */
async function refreshSingleDiscordUrl(url) {
  if (!isDiscordCdnUrl(url)) return url;
  const map = await refreshDiscordAttachmentUrls([url]);
  return map.get(url) || url;
}

/**
 * Tente de résoudre et rafraîchir l'URL d'une bannière de campagne.
 * Vérifie d'abord l'expiration, puis utilise refresh-urls, et en repli le message Discord hébergeant l'image.
 */
async function resolveFreshBannerUrl(client, campaign) {
  if (!campaign || !campaign.bannerUrl) return null;

  const currentUrl = campaign.bannerUrl;

  // Si ce n'est pas une URL Discord CDN (ex: base64 data URI ou externe)
  if (!isDiscordCdnUrl(currentUrl)) {
    return currentUrl;
  }

  // 1. Tente de rafraîchir via l'API officielle Discord refresh-urls
  try {
    const refreshed = await refreshSingleDiscordUrl(currentUrl);
    if (refreshed && refreshed !== currentUrl) {
      return refreshed;
    }
  } catch (err) {
    console.warn('[DiscordMedia] Erreur refreshSingleDiscordUrl:', err?.message);
  }

  // 2. Si refresh-urls n'a rien changé et qu'on a le messageId & channelId Discord du DM
  if (client && campaign.bannerChannelId && campaign.bannerMessageId) {
    try {
      const channel = await client.channels.fetch(campaign.bannerChannelId).catch(() => null);
      if (channel) {
        const msg = await channel.messages.fetch(campaign.bannerMessageId).catch(() => null);
        if (msg && msg.attachments.size > 0) {
          const freshAttachment = msg.attachments.first();
          if (freshAttachment && freshAttachment.url) {
            return freshAttachment.url;
          }
        }
      }
    } catch (msgErr) {
      console.warn('[DiscordMedia] Erreur fetch message DM:', msgErr?.message);
    }
  }

  return currentUrl;
}

/**
 * Scanner de secours : parcourt les DMs avec l'utilisateur ou le bot owner
 * pour retrouver les bannières envoyées par le bot (messages contenant "[Bannière").
 */
async function findBannerInDMs(client, targetUser, campaign) {
  if (!client || !targetUser) return null;
  try {
    const dm = await targetUser.createDM().catch(() => null);
    if (!dm) return null;

    const messages = await dm.messages.fetch({ limit: 50 }).catch(() => null);
    if (!messages) return null;

    // Cherche d'abord un message mentionnant spécifiquement cette campagne (ID ou titre)
    const specificMsg = messages.find(m =>
      m.author.id === client.user.id &&
      m.attachments.size > 0 &&
      (m.content.includes(campaign.id) || (campaign.title && m.content.toUpperCase().includes(campaign.title.toUpperCase())))
    );
    if (specificMsg) {
      const att = specificMsg.attachments.first();
      return { url: att.url, messageId: specificMsg.id, channelId: dm.id };
    }

    // Sinon, cherche les messages contenant [Bannière
    const bannerMsgs = messages.filter(m =>
      m.author.id === client.user.id &&
      m.attachments.size > 0 &&
      (m.content.includes('[Bannière') || m.attachments.some(a => a.name && a.name.includes('banner')))
    );

    if (bannerMsgs.size > 0) {
      // Retourne le plus récent
      const latestMsg = bannerMsgs.first();
      const att = latestMsg.attachments.first();
      return { url: att.url, messageId: latestMsg.id, channelId: dm.id };
    }
  } catch (err) {
    console.error('[DiscordMedia] Erreur scan DM:', err?.message);
  }
  return null;
}

module.exports = {
  isDiscordCdnUrl,
  isDiscordUrlExpired,
  refreshDiscordAttachmentUrls,
  refreshSingleDiscordUrl,
  resolveFreshBannerUrl,
  findBannerInDMs
};
