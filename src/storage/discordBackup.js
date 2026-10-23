const {
  AttachmentBuilder
} = require('discord.js');
const {
  getGuildState,
  restoreGuildState
} = require('./store');

/**
 * Récupère l'utilisateur Discord propriétaire de l'application/bot.
 */
async function getBotOwnerUser(client) {
  try {
    if (process.env.OWNER_ID) {
      const u = await client.users.fetch(process.env.OWNER_ID).catch(() => null);
      if (u) return u;
    }

    const app = await client.application.fetch().catch(() => null);
    if (!app || !app.owner) return null;

    // Si l'application appartient à une Team
    if (app.owner.ownerId || app.owner.ownerUserId) {
      const ownerId = app.owner.ownerId || app.owner.ownerUserId;
      return await client.users.fetch(ownerId).catch(() => null);
    }
    if (app.owner.members && app.owner.members.size > 0) {
      const firstMember = app.owner.members.first();
      return firstMember?.user || null;
    }

    // Si c'est un compte développeur individuel
    if (app.owner.id) {
      return await client.users.fetch(app.owner.id).catch(() => null);
    }
  } catch (err) {
    console.error('[Backup] Erreur détection propriétaire du bot:', err?.message);
  }
  return null;
}

/**
 * Supprime le salon #jdr-donnees sur le serveur s'il existait pour laisser le serveur 100% propre.
 */
async function cleanupOldBackupChannel(discordGuild) {
  try {
    const channels = await discordGuild.channels.fetch().catch(() => null);
    if (!channels) return;
    const oldCh = channels.find(ch => ch && ch.name === 'jdr-donnees');
    if (oldCh) {
      await oldCh.delete().catch(() => null);
      console.log(`[Backup] Ancien salon #jdr-donnees supprimé avec succès sur "${discordGuild.name}".`);
    }
  } catch {
    // Ignore si pas les permissions
  }
}

/**
 * Sauvegarde l'état d'un serveur Discord en Message Privé (DM) avec le propriétaire du bot.
 * Met à jour un seul et unique message pour ne pas polluer les DMs.
 */
async function saveBackupToDiscord(client, guildId) {
  try {
    const { guild: guildData } = getGuildState(guildId);
    if (!guildData || (!guildData.campaigns?.length && !guildData.channelId)) {
      return;
    }

    const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
    const guildName = discordGuild ? discordGuild.name : guildId;

    const ownerUser = await getBotOwnerUser(client);
    if (!ownerUser) {
      console.warn('[Backup] Propriétaire du bot introuvable pour la sauvegarde en DM.');
      return;
    }

    const dm = await ownerUser.createDM().catch(() => null);
    if (!dm) {
      console.warn('[Backup] Impossible d\'ouvrir les DMs avec le propriétaire.');
      return;
    }

    const jsonStr = JSON.stringify(guildData, null, 2);
    const buffer = Buffer.from(jsonStr, 'utf8');
    const fileName = `jdr-state-${guildId}.json`;
    const attachment = new AttachmentBuilder(buffer, { name: fileName });

    const messages = await dm.messages.fetch({ limit: 30 }).catch(() => null);
    const existingMsg = messages ? messages.find(
      m => m.author.id === client.user.id && m.attachments.some(a => a.name === fileName || a.name === 'jdr-state.json')
    ) : null;

    const dateStr = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
    const content = `📦 **Sauvegarde Tables JDR** — Serveur **${guildName}**\n*Dernière synchro : ${dateStr}*\n*(Ce fichier en DM assure la sauvegarde permanente de vos données lors des redémarrages de l'hébergeur Render. Ne pas supprimer ce message.)*`;

    if (existingMsg) {
      await existingMsg.edit({ content, files: [attachment], attachments: [] });
    } else {
      await dm.send({ content, files: [attachment] });
    }

    // Nettoie l'ancien salon #jdr-donnees sur le serveur pour ne laisser aucun salon superflu
    if (discordGuild) {
      await cleanupOldBackupChannel(discordGuild);
    }
  } catch (err) {
    console.error(`[Backup] Erreur lors de la sauvegarde en DM (${guildId}):`, err?.message);
  }
}

/**
 * Restaure l'état d'un serveur Discord depuis le message privé (DM) avec le propriétaire du bot.
 */
async function restoreBackupFromDiscord(client, guildId) {
  try {
    const ownerUser = await getBotOwnerUser(client);
    if (!ownerUser) return null;

    const dm = await ownerUser.createDM().catch(() => null);
    if (!dm) return null;

    const messages = await dm.messages.fetch({ limit: 30 }).catch(() => null);
    if (!messages) return null;

    const fileName = `jdr-state-${guildId}.json`;
    const backupMsg = messages.find(
      m => m.author.id === client.user.id && m.attachments.some(a => a.name === fileName || a.name === 'jdr-state.json')
    );

    if (!backupMsg) return null;

    const att = backupMsg.attachments.find(a => a.name === fileName || a.name === 'jdr-state.json');
    if (!att || !att.url) return null;

    const res = await fetch(att.url);
    if (!res.ok) return null;

    const data = await res.json();
    if (data && Array.isArray(data.campaigns)) {
      console.log(`[Backup] Données restaurées avec succès depuis DM pour le serveur "${guildId}" (${data.campaigns.length} table(s)).`);
      return restoreGuildState(guildId, data);
    }
  } catch (err) {
    console.error(`[Backup] Erreur restauration depuis DM (${guildId}):`, err?.message);
  }
  return null;
}

module.exports = {
  saveBackupToDiscord,
  restoreBackupFromDiscord,
  getBotOwnerUser
};
