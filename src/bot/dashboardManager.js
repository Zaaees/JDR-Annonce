const {
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  TextDisplayBuilder,
  MessageFlags
} = require('discord.js');
const {
  getGuildState,
  restoreGuildState,
  setDashboardMessageId,
  setCampaignPingMessageId
} = require('../storage/store');
const { renderDashboardBuffer, renderCampaignCardBuffer } = require('../renderer/boardRenderer');
const { embedStateInPng, extractStateFromPng } = require('../utils/pngState');
const { saveBackupToDiscord, restoreBackupFromDiscord, getBotOwnerUser } = require('../storage/discordBackup');
const { findBannerInDMs } = require('../utils/discordMedia');
const { updateCampaignConfig, updateCampaignMembers, setCampaignNudge } = require('../storage/store');
const { runExclusive } = require('../utils/mutex');
const { syncGuildEvents } = require('./scheduledEvents');

// Délai minimum entre deux relances des retardataires pour une même table (anti-spam)
const NUDGE_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/**
 * Récupère tous les membres humains possédant le @Rôle Discord d'une campagne.
 */
async function getRolePlayers(discordGuild, campaign) {
  try {
    await discordGuild.roles.fetch();
    await discordGuild.members.fetch();
  } catch {
    // Utilise le cache existant si rate-limited
  }

  const players = [];
  for (const [, member] of discordGuild.members.cache) {
    if (member.user.bot) continue;
    if (!member.roles.cache.has(campaign.roleId)) continue;

    const votedDays = campaign.votes && Array.isArray(campaign.votes[member.id])
      ? campaign.votes[member.id]
      : null;

    players.push({
      id: member.id,
      name: member.displayName,
      avatarUrl: member.user.displayAvatarURL({ extension: 'png', size: 128 }),
      voted: votedDays !== null,
      days: votedDays || []
    });
  }

  // Mémorise la composition à jour de la table (conflits de planning par joueur/MJ)
  if (players.length > 0) {
    updateCampaignMembers(discordGuild.id, campaign.id, players.map(p => p.id));
  }

  return players;
}

/**
 * Construit les composants sous l'image du Méga-Dashboard.
 */
function buildDashboardComponents(campaigns) {
  if (!campaigns || campaigns.length === 0) {
    return [];
  }

  const voteSelect = new StringSelectMenuBuilder()
    .setCustomId('select_campaign')
    .setPlaceholder('Voter pour une table (Joueurs)...')
    .addOptions(
      campaigns.slice(0, 25).map(c => ({
        label: c.title.slice(0, 100),
        description: c.roleName.startsWith('@') ? c.roleName : `@${c.roleName}`,
        value: c.id
      }))
    );

  const mjButtonRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('open_mj_menu')
      .setLabel('Gérer une table (MJ)')
      .setStyle(ButtonStyle.Secondary)
  );

  return [
    new ActionRowBuilder().addComponents(voteSelect),
    mjButtonRow
  ];
}

/**
 * Nettoie les messages obsolètes dans le salon d'annonces pour qu'il ne reste
 * que l'affiche principale (dashboardMessageId) et les pings actuels des tables actives.
 */
async function cleanupObsoleteChannelMessages(client, guildId, channel) {
  try {
    const { guild: guildData } = getGuildState(guildId);
    if (!guildData.dashboardMessageId) return;

    const validMessageIds = new Set([guildData.dashboardMessageId]);
    for (const c of guildData.campaigns) {
      if (c.lastPingMessageId) {
        validMessageIds.add(c.lastPingMessageId);
      }
      // La relance des retardataires n'est conservée que tant que le sondage est ouvert
      if (c.lastNudgeMessageId && c.status === 'poll') {
        validMessageIds.add(c.lastNudgeMessageId);
      }
    }

    const recentMessages = await channel.messages.fetch({ limit: 30 }).catch(() => null);
    if (!recentMessages) return;

    for (const [msgId, msg] of recentMessages) {
      if (!validMessageIds.has(msgId) && msg.author && msg.author.id === client.user.id) {
        await msg.delete().catch(() => null);
      }
    }
  } catch {
    // Ignore si permission manquante
  }
}

/**
 * Régénère l'affichage du Méga-Dashboard et met à jour le message permanent dans le salon.
 * Utilise Discord Components V2 (Option B) : bannières larges empilées dans un seul message,
 * avec boutons [Voter] et [Gérer (MJ)] intégrés directement sous chaque JDR.
 */
async function refreshDashboardMessageUnsafe(client, guildId) {
  const { guild: guildData } = getGuildState(guildId);
  if (!guildData.channelId) return null;

  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  if (!discordGuild) return null;

  const channel = await discordGuild.channels.fetch(guildData.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return null;

  const enrichedCampaigns = [];
  for (const c of guildData.campaigns) {
    const players = await getRolePlayers(discordGuild, c);
    const role = discordGuild.roles.cache.get(c.roleId);
    enrichedCampaigns.push({
      ...c,
      roleName: role ? `@${role.name}` : c.roleName,
      roleColor: role && role.hexColor !== '#000000' ? role.hexColor : (c.roleColor || '#f59e0b'),
      players
    });
  }

  // Format Discord Components V2 (Option B) :
  // Chaque JDR possède son propre Container avec sa bannière large et ses boutons dédiés
  const files = [];
  const containers = [];

  if (enrichedCampaigns.length === 0) {
    // Cas où aucune table n'est active
    const rawPngBuffer = await renderDashboardBuffer([]);
    const pngBuffer = embedStateInPng(rawPngBuffer, guildData);
    files.push(new AttachmentBuilder(pngBuffer, { name: 'sessions-jdr.png' }));

    const emptyText = new TextDisplayBuilder().setContent(
      '### 🎲 Tableau des Sessions JDR\n*Aucune table JDR active pour le moment.*\n\nUtilisez la commande `/jdr creer` pour ouvrir les inscriptions d’une campagne !'
    );
    const emptyContainer = new ContainerBuilder()
      .setAccentColor(0x3b82f6)
      .addTextDisplayComponents(emptyText);
    containers.push(emptyContainer);
  } else {
    for (let i = 0; i < enrichedCampaigns.length; i++) {
      const c = enrichedCampaigns[i];
      const rawCardBuffer = await renderCampaignCardBuffer(c, i, guildId);
      // Intègre l'état complet du serveur dans les métadonnées PNG de la première image (pour Render Free)
      const cardBuffer = (i === 0) ? embedStateInPng(rawCardBuffer, guildData) : rawCardBuffer;
      const fileName = i === 0 ? 'sessions-jdr.png' : `sessions-jdr-${i}.png`;
      files.push(new AttachmentBuilder(cardBuffer, { name: fileName }));

      const hexColor = (c.roleColor && c.roleColor !== '#000000') ? c.roleColor : '#f59e0b';
      const accentInt = parseInt(hexColor.replace('#', ''), 16) || 0xf59e0b;

      const mediaItem = new MediaGalleryItemBuilder().setURL(`attachment://${fileName}`);
      const mediaGallery = new MediaGalleryBuilder().addItems(mediaItem);

      let voteLabel = '🎲 Voter';
      let voteDisabled = false;
      if (c.status === 'paused') {
        voteLabel = '⏸️ Table en pause';
        voteDisabled = true;
      } else if (c.status === 'prep') {
        voteLabel = '📝 Préparation en cours';
        voteDisabled = true;
      } else if (c.status === 'confirmed') {
        voteLabel = '✅ Session fixée';
        voteDisabled = true;
      }

      const buttonsRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`vote_open:${c.id}`)
          .setLabel(voteLabel)
          .setStyle(voteDisabled ? ButtonStyle.Secondary : ButtonStyle.Primary)
          .setDisabled(voteDisabled),
        new ButtonBuilder()
          .setCustomId(`mj_open:${c.id}`)
          .setLabel('Gérer (MJ)')
          .setStyle(ButtonStyle.Secondary)
      );

      const container = new ContainerBuilder()
        .setAccentColor(accentInt)
        .addMediaGalleryComponents(mediaGallery);

      // Si le nombre total de tables permet d'ajouter les boutons directement sous chaque carte (< 7 tables = < 40 composants)
      if (enrichedCampaigns.length <= 6) {
        container.addActionRowComponents(buttonsRow);
      }
      containers.push(container);
    }

    // Si plus de 6 tables, boutons regroupés en bas pour respecter la limite de 40 composants Discord
    if (enrichedCampaigns.length > 6) {
      const fallbackRows = buildDashboardComponents(enrichedCampaigns);
      fallbackRows.forEach(r => containers.push(r));
    }
  }

  const payload = {
    content: null,
    embeds: [],
    files,
    components: containers,
    flags: [MessageFlags.IsComponentsV2]
  };

  let targetMsg = null;
  if (guildData.dashboardMessageId) {
    const existingMsg = await channel.messages.fetch(guildData.dashboardMessageId).catch(() => null);
    if (existingMsg) {
      try {
        targetMsg = await existingMsg.edit({
          ...payload,
          attachments: []
        });
      } catch (err) {
        console.warn('[Dashboard] Échec edit V2 sur ancien message (probablement legacy). Recréation propre :', err?.message);
        await existingMsg.delete().catch(() => null);
        targetMsg = null;
      }
    }
  }

  if (!targetMsg) {
    try {
      targetMsg = await channel.send(payload);
      setDashboardMessageId(guildId, targetMsg.id);
    } catch (sendErr) {
      console.error('[Dashboard] Erreur envoi Components V2, tentative repli legacy :', sendErr?.message);
      // Fallback au mode legacy si Discord rejette Components V2 sur ce salon
      const legacyRawBuffer = await renderDashboardBuffer(enrichedCampaigns, guildId);
      const legacyBuffer = embedStateInPng(legacyRawBuffer, guildData);
      const legacyAttachment = new AttachmentBuilder(legacyBuffer, { name: 'sessions-jdr.png' });
      const legacyComponents = buildDashboardComponents(enrichedCampaigns);
      targetMsg = await channel.send({
        content: '',
        files: [legacyAttachment],
        components: legacyComponents
      });
      setDashboardMessageId(guildId, targetMsg.id);
    }
  }

  // Synchronise les événements Discord natifs (création / déplacement / suppression)
  // avant la sauvegarde, pour que les identifiants d'événements soient inclus dans le backup.
  await syncGuildEvents(client, guildId);

  // Sauvegarde permanente sur Discord (#jdr-donnees) pour survivre aux redémarrages de Render
  await saveBackupToDiscord(client, guildId).catch(() => null);

  // Nettoie tout message obsolète dans le salon
  await cleanupObsoleteChannelMessages(client, guildId, channel).catch(() => null);

  return targetMsg;
}

// Rafraîchissement déjà planifié mais pas encore démarré, par serveur (permet de regrouper les appels)
const pendingRefreshes = new Map();

/**
 * Régénère le Méga-Dashboard (voir refreshDashboardMessageUnsafe).
 * Les rafraîchissements d'un même serveur sont exécutés l'un après l'autre (jamais en parallèle),
 * ce qui évite les doublons de message ou les écrasements lors de votes simultanés.
 * Si un rafraîchissement est déjà en attente, il est réutilisé : il lira l'état le plus récent.
 */
function refreshDashboardMessage(client, guildId) {
  const queued = pendingRefreshes.get(guildId);
  if (queued) return queued;

  const promise = runExclusive(`refresh:${guildId}`, async () => {
    pendingRefreshes.delete(guildId); // tout nouvel appel planifiera une nouvelle exécution
    return refreshDashboardMessageUnsafe(client, guildId);
  });
  pendingRefreshes.set(guildId, promise);
  return promise;
}

/**
 * Supprime le message de ping d'une campagne spécifique (ex: session passée, date retirée ou table supprimée).
 * Supprime également la dernière relance des retardataires de cette table.
 */
async function deleteCampaignPing(client, guildId, campaign) {
  if (!campaign || (!campaign.lastPingMessageId && !campaign.lastNudgeMessageId)) return;
  const { guild: guildData } = getGuildState(guildId);
  if (!guildData.channelId) return;

  const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
  if (channel && channel.isTextBased()) {
    if (campaign.lastPingMessageId) {
      const oldPing = await channel.messages.fetch(campaign.lastPingMessageId).catch(() => null);
      if (oldPing) {
        await oldPing.delete().catch(() => null);
      }
    }
    if (campaign.lastNudgeMessageId) {
      const oldNudge = await channel.messages.fetch(campaign.lastNudgeMessageId).catch(() => null);
      if (oldNudge) {
        await oldNudge.delete().catch(() => null);
      }
    }
  }
  setCampaignPingMessageId(guildId, campaign.id, null);
  setCampaignNudge(guildId, campaign.id, null);
}

/**
 * Tente de restaurer l'état d'un serveur à partir d'un message Discord contenant `sessions-jdr.png`.
 */
async function tryRestoreStateFromMessage(guildId, message) {
  if (!message || !message.attachments || message.attachments.size === 0) return null;
  const att = message.attachments.find(a => a.name && a.name.includes('sessions-jdr')) || message.attachments.first();
  if (!att || !att.url) return null;

  try {
    const res = await fetch(att.url);
    if (!res.ok) return null;
    const arrayBuf = await res.arrayBuffer();
    const extracted = extractStateFromPng(Buffer.from(arrayBuf));
    if (extracted && Array.isArray(extracted.campaigns)) {
      extracted.channelId = message.channelId;
      extracted.dashboardMessageId = message.id;
      return restoreGuildState(guildId, extracted);
    }
  } catch (err) {
    console.error('Erreur restauration PNG:', err);
  }
  return null;
}

/**
 * Au démarrage du bot, restaure automatiquement les données depuis Discord (#jdr-donnees ou DM).
 */
async function autoRecoverGuildsFromDiscord(client) {
  for (const [guildId, discordGuild] of client.guilds.cache) {
    let { guild: localGuild } = getGuildState(guildId);
    if (localGuild.campaigns && localGuild.campaigns.length > 0) {
      continue;
    }

    // 1. Restauration prioritaire depuis le salon dédié #jdr-donnees ou DM
    const restored = await restoreBackupFromDiscord(client, guildId);
    if (restored && restored.campaigns && restored.campaigns.length > 0) {
      continue;
    }

    // 2. Repli legacy si le salon #jdr-donnees n'était pas encore créé
    try {
      const channels = await discordGuild.channels.fetch();
      const textChannels = Array.from(channels.values())
        .filter(ch => ch && ch.isTextBased && ch.isTextBased() && ch.viewable)
        .sort((a, b) => {
          const score = name => (/jdr|session|annonce|table|calendrier|planning/i.test(name) ? 0 : 1);
          return score(a.name || '') - score(b.name || '');
        });

      for (const ch of textChannels) {
        const messages = await ch.messages.fetch({ limit: 15 }).catch(() => null);
        if (!messages) continue;

        const botDashboardMsg = messages.find(
          m =>
            m.author &&
            m.author.id === client.user.id &&
            m.attachments &&
            m.attachments.some(a => a.name && a.name.includes('sessions-jdr'))
        );

        if (botDashboardMsg) {
          const restored = await tryRestoreStateFromMessage(guildId, botDashboardMsg);
          if (restored) {
            console.log(
              `[Auto-Recovery] État restauré depuis Discord pour le serveur "${discordGuild.name}" (${restored.campaigns.length} table(s)).`
            );
            break;
          }
        }
      }
    } catch {
      // Ignore les salons non accessibles
    }

    // Récupération des bannières manquantes depuis les DMs envoyés par le bot
    const { guild: currentGuildData } = getGuildState(guildId);
    if (currentGuildData && Array.isArray(currentGuildData.campaigns)) {
      for (const c of currentGuildData.campaigns) {
        if (!c.bannerUrl) {
          const ownerUser = await getBotOwnerUser(client);
          const recovered = await findBannerInDMs(client, ownerUser, c);
          if (recovered && recovered.url) {
            console.log(`[AutoRecover] Bannière retrouvée en DM pour "${c.title}" !`);
            updateCampaignConfig(guildId, c.id, {
              bannerUrl: recovered.url,
              bannerMessageId: recovered.messageId,
              bannerChannelId: recovered.channelId
            });
          }
        }
      }
    }
  }
}

/**
 * Envoie un ping au @Rôle du JDR dans le salon (et supprime systématiquement l'ancien ping de ce même JDR).
 */
async function sendRolePing(client, guildId, campaign, messageText) {
  const { guild: guildData } = getGuildState(guildId);
  if (!guildData.channelId || !campaign.roleId) return;

  const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return;

  // Envoi + enregistrement de l'ID du ping de façon atomique vis-à-vis du rafraîchissement
  // (sinon le nettoyage du salon pourrait supprimer le ping avant qu'il soit enregistré).
  const sent = await runExclusive(`refresh:${guildId}`, async () => {
    // Relit l'état courant : le ping et la relance précédents sont remplacés
    const { guild: freshGuild } = getGuildState(guildId);
    const current = freshGuild.campaigns.find(c => c.id === campaign.id) || campaign;

    for (const oldId of [current.lastPingMessageId, current.lastNudgeMessageId]) {
      if (!oldId) continue;
      const oldMsg = await channel.messages.fetch(oldId).catch(() => null);
      if (oldMsg) {
        await oldMsg.delete().catch(() => null);
      }
    }
    setCampaignNudge(guildId, campaign.id, null);

    const message = await channel.send({
      content: `<@&${campaign.roleId}> ${messageText}`,
      allowedMentions: { roles: [campaign.roleId] }
    }).catch(() => null);

    if (message) {
      setCampaignPingMessageId(guildId, campaign.id, message.id);
    }
    return message;
  });

  if (sent) {
    // Met à jour les métadonnées PNG pour mémoriser le nouvel ID de ping
    await refreshDashboardMessage(client, guildId).catch(() => null);
  }
}

/**
 * Relance uniquement les joueurs du @Rôle qui n'ont pas encore voté (sans déranger les autres).
 * Anti-spam : une seule relance visible par table (la précédente est remplacée) et un délai
 * minimal de NUDGE_COOLDOWN_MS entre deux relances.
 *
 * @returns {Promise<{status: 'SENT'|'NONE_MISSING'|'COOLDOWN'|'NOT_POLLING'|'NO_CHANNEL'|'NOT_FOUND'|'ERROR',
 *   missingCount?: number, totalCount?: number, retryAt?: number}>}
 */
async function sendLateVotersNudge(client, guildId, campaignId) {
  const { guild: guildData } = getGuildState(guildId);
  const campaign = guildData.campaigns.find(c => c.id === campaignId);
  if (!campaign) return { status: 'NOT_FOUND' };
  if (campaign.status !== 'poll') return { status: 'NOT_POLLING' };
  if (!guildData.channelId) return { status: 'NO_CHANNEL' };

  if (campaign.lastNudgeAt && Date.now() - campaign.lastNudgeAt < NUDGE_COOLDOWN_MS) {
    return { status: 'COOLDOWN', retryAt: campaign.lastNudgeAt + NUDGE_COOLDOWN_MS };
  }

  const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
  const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
  if (!discordGuild || !channel || !channel.isTextBased()) return { status: 'NO_CHANNEL' };

  const players = await getRolePlayers(discordGuild, campaign);
  const missing = players.filter(p => !p.voted);
  if (players.length === 0 || missing.length === 0) {
    return { status: 'NONE_MISSING', totalCount: players.length };
  }

  const mentionIds = missing.map(p => p.id);
  const voted = players.length - missing.length;
  const content =
    `🔔 ${mentionIds.map(id => `<@${id}>`).join(' ')}\n` +
    `Il manque votre vote pour **${campaign.title}** (${voted}/${players.length} ont déjà répondu).`;

  const sent = await runExclusive(`refresh:${guildId}`, async () => {
    const { guild: freshGuild } = getGuildState(guildId);
    const current = freshGuild.campaigns.find(c => c.id === campaignId);
    if (!current || current.status !== 'poll') return null;

    // Remplace la relance précédente pour ne pas polluer le salon
    if (current.lastNudgeMessageId) {
      const oldMsg = await channel.messages.fetch(current.lastNudgeMessageId).catch(() => null);
      if (oldMsg) {
        await oldMsg.delete().catch(() => null);
      }
    }

    const message = await channel.send({
      content,
      allowedMentions: { users: mentionIds }
    }).catch(() => null);

    if (message) {
      setCampaignNudge(guildId, campaignId, message.id);
    }
    return message;
  });

  if (!sent) return { status: 'ERROR' };
  return { status: 'SENT', missingCount: missing.length, totalCount: players.length };
}

module.exports = {
  getRolePlayers,
  refreshDashboardMessage,
  deleteCampaignPing,
  tryRestoreStateFromMessage,
  autoRecoverGuildsFromDiscord,
  sendRolePing,
  sendLateVotersNudge
};
