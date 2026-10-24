const {
  GuildScheduledEventPrivacyLevel,
  GuildScheduledEventEntityType,
  GuildScheduledEventStatus
} = require('discord.js');
const { getGuildState, setCampaignEventId } = require('../storage/store');
const { parseTimeInput, parisWallTimeToDate } = require('../utils/dates');

/**
 * Création / mise à jour / suppression automatique des Événements Discord natifs
 * (Scheduled Events) correspondant aux sessions de JDR confirmées.
 *
 * Permissions requises pour le bot : « Gérer les événements » (ManageEvents).
 * Toutes les erreurs sont absorbées : un échec d'événement ne doit jamais bloquer le bot.
 */

// Durée par défaut d'une session (Discord exige une date de fin pour un événement « externe »)
const DEFAULT_SESSION_DURATION_MS = 4 * 60 * 60 * 1000;

// Évite de répéter indéfiniment l'avertissement de permissions manquantes
const permissionWarnedGuilds = new Set();

/**
 * Calcule l'événement attendu pour une table (ou null si aucune session confirmée).
 */
function buildDesiredEvent(campaign) {
  if (!campaign || campaign.status !== 'confirmed' || !campaign.confirmedDateISO) return null;

  const { hours, minutes } = parseTimeInput(campaign.time);
  const start = parisWallTimeToDate(campaign.confirmedDateISO, hours, minutes);
  const end = new Date(start.getTime() + DEFAULT_SESSION_DURATION_MS);

  const roleLabel = campaign.roleName
    ? (String(campaign.roleName).startsWith('@') ? campaign.roleName : `@${campaign.roleName}`)
    : null;

  const lines = [`Session de JDR : ${campaign.title}`];
  if (campaign.mjName) lines.push(`MJ : ${campaign.mjName}`);
  if (roleLabel) lines.push(`Table : ${roleLabel}`);
  if (campaign.time) lines.push(`Heure : ${campaign.time}`);

  return {
    name: `🎲 ${campaign.title}`.slice(0, 100),
    description: lines.join('\n').slice(0, 1000),
    location: `Table ${campaign.title}${campaign.mjName ? ` — MJ ${campaign.mjName}` : ''}`.slice(0, 100),
    start,
    end
  };
}

function isLiveEvent(event) {
  return (
    event &&
    (event.status === GuildScheduledEventStatus.Scheduled ||
      event.status === GuildScheduledEventStatus.Active)
  );
}

/**
 * Supprime un événement planifié, ou le termine proprement s'il est déjà en cours.
 */
async function endOrDeleteEvent(event) {
  if (!event) return;
  try {
    if (event.status === GuildScheduledEventStatus.Active) {
      await event.setStatus(GuildScheduledEventStatus.Completed);
    } else if (event.status === GuildScheduledEventStatus.Scheduled) {
      await event.delete();
    }
  } catch (err) {
    console.error('[Events] Impossible de supprimer/terminer l\'événement:', err?.message);
  }
}

function warnMissingPermission(guildId, err) {
  if (err && (err.code === 50013 || err.status === 403)) {
    if (!permissionWarnedGuilds.has(guildId)) {
      permissionWarnedGuilds.add(guildId);
      console.warn(
        `[Events] Permission « Gérer les événements » manquante sur le serveur ${guildId} : ` +
          'les événements Discord ne seront pas créés tant que le bot ne l\'a pas.'
      );
    }
    return true;
  }
  return false;
}

/**
 * Synchronise l'événement Discord d'une seule table avec son état actuel.
 */
async function syncCampaignEvent(client, discordGuild, events, campaign, otherEventIds) {
  const guildId = discordGuild.id;
  const desired = buildDesiredEvent(campaign);

  let event = campaign.scheduledEventId ? events.get(campaign.scheduledEventId) : null;

  // L'événement stocké n'existe plus, est terminé ou annulé -> on l'oublie
  if (campaign.scheduledEventId && !isLiveEvent(event)) {
    event = null;
    setCampaignEventId(guildId, campaign.id, null);
    campaign.scheduledEventId = null;
  }

  // Plus de session confirmée -> on retire l'événement
  if (!desired) {
    if (event) {
      await endOrDeleteEvent(event);
      setCampaignEventId(guildId, campaign.id, null);
    }
    return;
  }

  // Évite les doublons après une restauration d'état : on adopte un événement identique créé par le bot
  if (!event) {
    event = events.find(
      e =>
        e.creatorId === client.user.id &&
        e.status === GuildScheduledEventStatus.Scheduled &&
        e.name === desired.name &&
        !otherEventIds.has(e.id)
    ) || null;
    if (event) {
      setCampaignEventId(guildId, campaign.id, event.id);
    }
  }

  const startsInFuture = desired.start.getTime() > Date.now() + 5000;

  if (!event) {
    if (!startsInFuture) return; // Discord refuse de créer un événement dans le passé
    try {
      const created = await discordGuild.scheduledEvents.create({
        name: desired.name,
        description: desired.description,
        scheduledStartTime: desired.start,
        scheduledEndTime: desired.end,
        privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
        entityType: GuildScheduledEventEntityType.External,
        entityMetadata: { location: desired.location },
        reason: `Session JDR confirmée : ${campaign.title}`
      });
      setCampaignEventId(guildId, campaign.id, created.id);
      otherEventIds.add(created.id);
      console.log(`[Events] Événement créé pour "${campaign.title}".`);
    } catch (err) {
      if (!warnMissingPermission(guildId, err)) {
        console.error(`[Events] Échec création événement "${campaign.title}":`, err?.message);
      }
    }
    return;
  }

  // Événement déjà en cours : on ne le modifie plus
  if (event.status !== GuildScheduledEventStatus.Scheduled || !startsInFuture) return;

  const needsUpdate =
    event.scheduledStartTimestamp !== desired.start.getTime() ||
    event.name !== desired.name ||
    (event.description || '') !== desired.description ||
    (event.entityMetadata?.location || '') !== desired.location;

  if (needsUpdate) {
    try {
      await event.edit({
        name: desired.name,
        description: desired.description,
        scheduledStartTime: desired.start,
        scheduledEndTime: desired.end,
        entityMetadata: { location: desired.location },
        reason: `Session JDR mise à jour : ${campaign.title}`
      });
      console.log(`[Events] Événement mis à jour pour "${campaign.title}".`);
    } catch (err) {
      if (!warnMissingPermission(guildId, err)) {
        console.error(`[Events] Échec mise à jour événement "${campaign.title}":`, err?.message);
      }
    }
  }
}

/**
 * Synchronise les événements Discord de TOUTES les tables d'un serveur.
 * Idempotent : peut être appelé après chaque changement d'état (création, déplacement, retrait...).
 */
async function syncGuildEvents(client, guildId) {
  try {
    const { guild: guildData } = getGuildState(guildId);
    const campaigns = guildData.campaigns || [];
    const needsWork = campaigns.some(
      c => c.scheduledEventId || (c.status === 'confirmed' && c.confirmedDateISO)
    );
    if (!needsWork) return;

    const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;

    let events;
    try {
      events = await discordGuild.scheduledEvents.fetch();
    } catch (err) {
      console.error('[Events] Impossible de lister les événements:', err?.message);
      return;
    }

    const otherEventIds = new Set(campaigns.map(c => c.scheduledEventId).filter(Boolean));
    for (const campaign of campaigns) {
      await syncCampaignEvent(client, discordGuild, events, campaign, otherEventIds).catch(err =>
        console.error(`[Events] Erreur de synchronisation (${campaign.title}):`, err?.message)
      );
    }
  } catch (err) {
    console.error('[Events] Erreur de synchronisation globale:', err?.message);
  }
}

/**
 * À appeler AVANT la suppression d'une table : retire son événement Discord.
 */
async function removeCampaignEvent(client, guildId, campaign) {
  if (!campaign || !campaign.scheduledEventId) return;
  try {
    const discordGuild = await client.guilds.fetch(guildId).catch(() => null);
    if (!discordGuild) return;
    const event = await discordGuild.scheduledEvents.fetch(campaign.scheduledEventId).catch(() => null);
    await endOrDeleteEvent(event);
  } catch (err) {
    console.error('[Events] Erreur suppression événement:', err?.message);
  }
}

module.exports = {
  buildDesiredEvent,
  syncGuildEvents,
  removeCampaignEvent
};
