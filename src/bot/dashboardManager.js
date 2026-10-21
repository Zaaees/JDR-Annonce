const {
  AttachmentBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder
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
 * Récupère les membres humains possédant le @Rôle Discord d'une campagne.
 */
async function getRolePlayers(discordGuild, campaign) {
  try {
    await discordGuild.members.fetch();
  } catch {
    // Utilise le cache existant si rate-limited
  }

  const role = discordGuild.roles.cache.get(campaign.roleId);
  if (!role) {
    return [];
  }

  const players = [];
  for (const [, member] of role.members) {
    if (member.user.bot) continue;
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

  const select = new StringSelectMenuBuilder()
    .setCustomId('select_campaign')
    .setPlaceholder('Choisir une table...')
    .addOptions(
      campaigns.slice(0, 25).map(c => ({
        label: c.title.slice(0, 100),
        description: c.roleName.startsWith('@') ? c.roleName : `@${c.roleName}`,
        value: c.id
      }))
    );

  return [new ActionRowBuilder().addComponents(select)];
}

/**
 * Régénère l'image du Méga-Dashboard (avec sauvegarde invisible de l'état JSON intégrée au PNG)
 * et met à jour le message permanent dans le salon.
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
  // Grave l'état JSON complet dans les métadonnées invisibles du PNG pour survivre aux redémarrages Render Free
  const pngBuffer = embedStateInPng(rawPngBuffer, guildData);

  const attachment = new AttachmentBuilder(pngBuffer, { name: 'sessions-jdr.png' });
  const components = buildDashboardComponents(enrichedCampaigns);

  const payload = {
    content: '',
    files: [attachment],
    components
  };

  if (guildData.dashboardMessageId) {
    const existingMsg = await channel.messages.fetch(guildData.dashboardMessageId).catch(() => null);
    if (existingMsg) {
      await existingMsg.edit(payload);
      return existingMsg;
    }
  }

  const newMsg = await channel.send(payload);
  setDashboardMessageId(guildId, newMsg.id);
  return newMsg;
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
 * Au démarrage du bot (ex: après un redémarrage Render ayant vidé le disque local),
 * inspecte les salons des serveurs pour retrouver `sessions-jdr.png` et restaurer toutes les données.
 */
async function autoRecoverGuildsFromDiscord(client) {
  for (const [guildId, discordGuild] of client.guilds.cache) {
    const { guild: localGuild } = getGuildState(guildId);
    if (localGuild.campaigns && localGuild.campaigns.length > 0) {
      continue; // Déjà présent sur le disque
    }

    try {
      const channels = await discordGuild.channels.fetch();
      // Priorise les salons dont le nom évoque les sessions/annonces JDR
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
 * Envoie un ping au @Rôle du JDR dans le salon (et nettoie l'ancien ping de ce même JDR).
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
  }
}

module.exports = {
  getRolePlayers,
  refreshDashboardMessage,
  tryRestoreStateFromMessage,
  autoRecoverGuildsFromDiscord,
  sendRolePing
};
