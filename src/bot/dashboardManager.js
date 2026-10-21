const {
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle
} = require('discord.js');
const {
  getGuildState,
  restoreGuildState,
  setDashboardMessageId,
  setCampaignPingMessageId
} = require('../storage/store');
const { renderDashboardBuffer } = require('../renderer/boardRenderer');
const { embedStateInPng, extractStateFromPng } = require('../utils/pngState');

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
 * Régénère l'image du Méga-Dashboard et met à jour le message permanent dans le salon.
 */
async function refreshDashboardMessage(client, guildId) {
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

  const rawPngBuffer = await renderDashboardBuffer(enrichedCampaigns);
  const pngBuffer = embedStateInPng(rawPngBuffer, guildData);

  const attachment = new AttachmentBuilder(pngBuffer, { name: 'sessions-jdr.png' });
  const components = buildDashboardComponents(enrichedCampaigns);

  const payload = {
    content: '',
    files: [attachment],
    components
  };

  let targetMsg = null;
  if (guildData.dashboardMessageId) {
    const existingMsg = await channel.messages.fetch(guildData.dashboardMessageId).catch(() => null);
    if (existingMsg) {
      targetMsg = await existingMsg.edit(payload);
    }
  }

  if (!targetMsg) {
    targetMsg = await channel.send(payload);
    setDashboardMessageId(guildId, targetMsg.id);
  }

  
  return targetMsg;
}

/**
 * Supprime le message de ping d'une campagne spécifique (ex: session passée, date retirée ou table supprimée).
 */
async function deleteCampaignPing(client, guildId, campaign) {
  if (!campaign || !campaign.lastPingMessageId) return;
  const { guild: guildData } = getGuildState(guildId);
  if (!guildData.channelId) return;

  const channel = await client.channels.fetch(guildData.channelId).catch(() => null);
  if (channel && channel.isTextBased()) {
    const oldPing = await channel.messages.fetch(campaign.lastPingMessageId).catch(() => null);
    if (oldPing) {
      await oldPing.delete().catch(() => null);
    }
  }
  setCampaignPingMessageId(guildId, campaign.id, null);
}

/**
 * Tente de restaurer l'état d'un serveur à partir d'un message Discord contenant `sessions-jdr.png`.
 */
async function tryRestoreStateFromMessage(guildId, message) {
  if (!message || !message.attachments || message.attachments.size === 0) return null;
  const att = message.attachments.find(a => a.name === 'sessions-jdr.png') || message.attachments.first();
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
 * Au démarrage du bot, inspecte les salons des serveurs pour retrouver `sessions-jdr.png` et restaurer les données.
 */
async function autoRecoverGuildsFromDiscord(client) {
  for (const [guildId, discordGuild] of client.guilds.cache) {
    const { guild: localGuild } = getGuildState(guildId);
    if (localGuild.campaigns && localGuild.campaigns.length > 0) {
      continue;
    }

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
            m.attachments.some(a => a.name === 'sessions-jdr.png')
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

  if (campaign.lastPingMessageId) {
    const oldPing = await channel.messages.fetch(campaign.lastPingMessageId).catch(() => null);
    if (oldPing) {
      await oldPing.delete().catch(() => null);
    }
  }

  const sent = await channel.send({
    content: `<@&${campaign.roleId}> ${messageText}`,
    allowedMentions: { roles: [campaign.roleId] }
  }).catch(() => null);

  if (sent) {
    setCampaignPingMessageId(guildId, campaign.id, sent.id);
    // Met à jour les métadonnées PNG pour mémoriser le nouvel ID de ping
    await refreshDashboardMessage(client, guildId).catch(() => null);
  }
}

module.exports = {
  getRolePlayers,
  refreshDashboardMessage,
  deleteCampaignPing,
  tryRestoreStateFromMessage,
  autoRecoverGuildsFromDiscord,
  sendRolePing
};
