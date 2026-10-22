const {
  ChannelType,
  PermissionFlagsBits,
  AttachmentBuilder
} = require('discord.js');
const {
  getGuildState,
  restoreGuildState
} = require('./store');

const BACKUP_CHANNEL_NAME = 'jdr-donnees';
const BACKUP_FILE_NAME = 'jdr-state.json';

/**
 * Trouve ou crée le salon textuel privé dédié aux sauvegardes sur le serveur.
 */
async function getOrCreateBackupChannel(guild, client) {
  try {
    const channels = await guild.channels.fetch();
    const existing = channels.find(
      ch => ch && ch.isTextBased && ch.isTextBased() && ch.name === BACKUP_CHANNEL_NAME
    );
    if (existing) return existing;

    // Si le salon n'existe pas, on le crée masqué pour @everyone (invisible aux joueurs)
    const created = await guild.channels.create({
      name: BACKUP_CHANNEL_NAME,
      type: ChannelType.GuildText,
      topic: 'Sauvegarde automatique des tables JDR (ne pas supprimer)',
      permissionOverwrites: [
        {
          id: guild.id, // @everyone
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: client.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.AttachFiles,
            PermissionFlagsBits.ReadMessageHistory
          ]
        }
      ]
    });
    return created;
  } catch (err) {
    console.warn(`[Backup] Impossible d'accéder/créer #${BACKUP_CHANNEL_NAME} sur "${guild.name}":`, err?.message);
    return null;
  }
}

/**
 * Sauvegarde l'état d'un serveur Discord de façon permanente dans le salon privé #jdr-donnees ou en DM.
 */
async function saveBackupToDiscord(client, guildId) {
  try {
    const { guild: guildData } = getGuildState(guildId);
    if (!guildData || (!guildData.campaigns?.length && !guildData.channelId)) {
      return;
    }

    const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    const jsonStr = JSON.stringify(guildData, null, 2);
    const buffer = Buffer.from(jsonStr, 'utf8');
    const attachment = new AttachmentBuilder(buffer, { name: BACKUP_FILE_NAME });

    // 1. Essai prioritaire dans le salon privé #jdr-donnees du serveur
    const backupChannel = await getOrCreateBackupChannel(discordGuild, client);
    if (backupChannel) {
      const messages = await backupChannel.messages.fetch({ limit: 10 }).catch(() => null);
      const existingMsg = messages ? messages.find(
        m => m.author.id === client.user.id && m.attachments.some(a => a.name === BACKUP_FILE_NAME)
      ) : null;

      const dateStr = new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
      const content = `📦 **Sauvegarde Tables JDR**\n*Dernière mise à jour : ${dateStr}*\n*(Ce salon privé permet de conserver vos données lors des redémarrages de l'hébergeur Render. Ne pas supprimer ce salon ni ce message.)*`;

      if (existingMsg) {
        await existingMsg.edit({ content, files: [attachment], attachments: [] });
      } else {
        await backupChannel.send({ content, files: [attachment] });
      }
      return;
    }

    // 2. Fallback si le bot n'a pas la permission de créer un salon : sauvegarde en DM au propriétaire du bot
    const app = await client.application.fetch().catch(() => null);
    const owner = app ? (app.owner?.user || app.owner) : null;
    if (owner && owner.id) {
      const ownerUser = await client.users.fetch(owner.id).catch(() => null);
      if (ownerUser) {
        const fileName = `jdr-state-${guildId}.json`;
        const dmAtt = new AttachmentBuilder(buffer, { name: fileName });
        const dm = await ownerUser.createDM().catch(() => null);
        if (dm) {
          const dmMessages = await dm.messages.fetch({ limit: 15 }).catch(() => null);
          const existingDmMsg = dmMessages ? dmMessages.find(
            m => m.author.id === client.user.id && m.attachments.some(a => a.name === fileName)
          ) : null;
          const dmContent = `📦 [Sauvegarde JDR Auto - Serveur ${discordGuild.name} (${guildId})]`;
          if (existingDmMsg) {
            await existingDmMsg.edit({ content: dmContent, files: [dmAtt], attachments: [] });
          } else {
            await dm.send({ content: dmContent, files: [dmAtt] });
          }
        }
      }
    }
  } catch (err) {
    console.error(`[Backup] Erreur lors de la sauvegarde sur Discord (${guildId}):`, err);
  }
}

/**
 * Restaure l'état d'un serveur Discord depuis le salon privé #jdr-donnees ou depuis le DM du propriétaire.
 */
async function restoreBackupFromDiscord(client, guildId) {
  try {
    const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return null;

    // 1. Essai depuis le salon privé #jdr-donnees
    const channels = await discordGuild.channels.fetch().catch(() => null);
    if (channels) {
      const backupChannel = channels.find(
        ch => ch && ch.isTextBased && ch.isTextBased() && ch.name === BACKUP_CHANNEL_NAME
      );
      if (backupChannel) {
        const messages = await backupChannel.messages.fetch({ limit: 10 }).catch(() => null);
        if (messages) {
          const backupMsg = messages.find(
            m => m.author.id === client.user.id && m.attachments.some(a => a.name === BACKUP_FILE_NAME)
          );
          if (backupMsg) {
            const att = backupMsg.attachments.find(a => a.name === BACKUP_FILE_NAME);
            if (att && att.url) {
              const res = await fetch(att.url);
              if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.campaigns)) {
                  console.log(`[Backup] Données restaurées depuis #${BACKUP_CHANNEL_NAME} pour "${discordGuild.name}" (${data.campaigns.length} table(s)).`);
                  return restoreGuildState(guildId, data);
                }
              }
            }
          }
        }
      }
    }

    // 2. Essai depuis les DMs avec l'owner du bot
    const app = await client.application.fetch().catch(() => null);
    const owner = app ? (app.owner?.user || app.owner) : null;
    if (owner && owner.id) {
      const ownerUser = await client.users.fetch(owner.id).catch(() => null);
      if (ownerUser) {
        const dm = await ownerUser.createDM().catch(() => null);
        if (dm) {
          const dmMessages = await dm.messages.fetch({ limit: 20 }).catch(() => null);
          const fileName = `jdr-state-${guildId}.json`;
          const dmMsg = dmMessages ? dmMessages.find(
            m => m.author.id === client.user.id && m.attachments.some(a => a.name === fileName || a.name === BACKUP_FILE_NAME)
          ) : null;
          if (dmMsg) {
            const att = dmMsg.attachments.find(a => a.name === fileName || a.name === BACKUP_FILE_NAME);
            if (att && att.url) {
              const res = await fetch(att.url);
              if (res.ok) {
                const data = await res.json();
                if (data && Array.isArray(data.campaigns)) {
                  console.log(`[Backup] Données restaurées depuis DM pour "${discordGuild.name}" (${data.campaigns.length} table(s)).`);
                  return restoreGuildState(guildId, data);
                }
              }
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(`[Backup] Erreur lors de la restauration depuis Discord (${guildId}):`, err);
  }
  return null;
}

module.exports = {
  saveBackupToDiscord,
  restoreBackupFromDiscord,
  BACKUP_CHANNEL_NAME
};
