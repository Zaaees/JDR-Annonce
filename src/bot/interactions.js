const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
  PermissionFlagsBits
} = require('discord.js');
const {
  getGuildState,
  setGuildChannel,
  createCampaign,
  deleteCampaign,
  updateCampaignConfig,
  submitPlayerVote,
  setManualSessionDate,
  clearSessionDate,
  restartCampaignPoll,
  setCampaignStatus
} = require('../storage/store');
const {
  getRollingDays,
  getTodayISO,
  getMondayISO,
  getWeekDaysFromMonday,
  formatFullDateFR,
  formatDayMonthFR
} = require('../utils/dates');
const {
  getRolePlayers,
  refreshDashboardMessage,
  deleteCampaignPing,
  tryRestoreStateFromMessage,
  sendRolePing,
  sendLateVotersNudge
} = require('./dashboardManager');
const { createCropSession } = require('../server/cropServer');
const { restoreBackupFromDiscord } = require('../storage/discordBackup');
const { runExclusive } = require('../utils/mutex');
const { campaignsConflict } = require('../utils/schedulingOptimizer');
const { removeCampaignEvent } = require('./scheduledEvents');

// Sélections en cours (avant clic sur "Valider") : Map<`${campaignId}:${userId}`, Set<number>>
const draftSelections = new Map();

function getDraftKey(campaignId, userId) {
  return `${campaignId}:${userId}`;
}

function getOrInitDraft(campaign, userId) {
  const key = getDraftKey(campaign.id, userId);
  if (!draftSelections.has(key)) {
    const existing = campaign.votes && Array.isArray(campaign.votes[userId])
      ? campaign.votes[userId]
      : [];
    draftSelections.set(key, new Set(existing));
  }
  return draftSelections.get(key);
}

/**
 * Définition des commandes Slash (/jdr)
 */
function getSlashCommands() {
  const jdrCmd = new SlashCommandBuilder()
    .setName('jdr')
    .setDescription('Gestion des tables de JDR et du salon des sessions')
    .addSubcommand(sub =>
      sub
        .setName('salon')
        .setDescription('Définir le salon permanent où le tableau des sessions JDR est affiché')
        .addChannelOption(opt =>
          opt.setName('salon').setDescription('Le salon texte').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('creer')
        .setDescription('Créer une nouvelle table de JDR et lancer son sondage')
        .addStringOption(opt =>
          opt.setName('nom').setDescription('Nom de la campagne JDR').setRequired(true)
        )
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Rôle Discord regroupant les joueurs de ce JDR').setRequired(true)
        )
        .addUserOption(opt =>
          opt.setName('mj').setDescription('Membre qui sera le Maître du Jeu de cette table (par défaut vous-même)').setRequired(false)
        )
        .addStringOption(opt =>
          opt
            .setName('theme')
            .setDescription('Style visuel par défaut si aucune image n’est fournie')
            .setRequired(false)
            .addChoices(
              { name: 'Fantasy', value: 'fantasy' },
              { name: 'Cyberpunk / Sci-Fi', value: 'cyberpunk' },
              { name: 'Horreur / Occulte', value: 'horror' },
              { name: 'Moderne / Sombre', value: 'modern' }
            )
        )
        .addAttachmentOption(opt =>
          opt.setName('banniere').setDescription('Image de fond personnalisée pour la bannière de ce JDR').setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('mj')
        .setDescription('Changer le Maître du Jeu d’une table JDR')
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Le rôle Discord du JDR').setRequired(true)
        )
        .addUserOption(opt =>
          opt.setName('mj').setDescription('Le nouveau MJ pour cette table').setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('banniere')
        .setDescription('Modifier l’image de fond d’une table JDR existante')
        .addRoleOption(opt =>
          opt.setName('role').setDescription('Le rôle Discord du JDR à modifier').setRequired(true)
        )
        .addAttachmentOption(opt =>
          opt.setName('image').setDescription('La nouvelle image de bannière').setRequired(true)
        )
    );

  return [jdrCmd.toJSON()];
}

function isUserMJ(interaction, campaign) {
  if (!campaign) return false;
  if (interaction.user.id === campaign.mjId) return true;
  if (
    interaction.memberPermissions &&
    (interaction.memberPermissions.has(PermissionFlagsBits.Administrator) ||
      interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild))
  ) {
    return true;
  }
  return false;
}

function isUserInRole(interaction, campaign) {
  if (!campaign || !campaign.roleId) return false;
  const memberRoles = interaction.member && interaction.member.roles;
  if (!memberRoles) return false;
  if (memberRoles.cache) {
    return memberRoles.cache.has(campaign.roleId);
  }
  if (Array.isArray(memberRoles)) {
    return memberRoles.includes(campaign.roleId);
  }
  return false;
}

/**
 * Panneau de vote JOUEUR avec boutons de jours cliquables (Vert = sélectionné, Gris = non sélectionné)
 * sans fermeture automatique, + bouton "Indisponible" avec confirmation et bouton "Valider".
 * Réparti sur 2 semaines (Lundi à Dimanche) avec 5 ActionRows conformes aux limites Discord.
 */
function buildPlayerVotePanel(campaign, userId) {
  const startDateISO = campaign.startDateISO || campaign.weekMondayISO || getMondayISO();
  const weekDays = getRollingDays(startDateISO, 14);
  const selectedSet = getOrInitDraft(campaign, userId);

  // Compteur d'affluence : nombre de joueurs disponibles chaque jour, sur le total attendu.
  // Compte les votes déjà validés des AUTRES joueurs + la sélection en cours de ce joueur.
  const knownMembers = Array.isArray(campaign.memberIds) ? campaign.memberIds : [];
  const votes = campaign.votes || {};
  const expectedIds = new Set(knownMembers.length > 0 ? knownMembers : Object.keys(votes));
  expectedIds.add(userId);
  const totalPlayers = expectedIds.size;
  const availabilityCount = idx => {
    let count = 0;
    for (const [voterId, days] of Object.entries(votes)) {
      if (voterId === userId || !Array.isArray(days)) continue;
      if (knownMembers.length > 0 && !knownMembers.includes(voterId)) continue; // ancien membre du rôle
      if (days.includes(idx)) count++;
    }
    if (selectedSet.has(idx)) count++;
    return count;
  };
  const buildDayLabel = (d, idx, isSelected) =>
    `${isSelected ? '✓ ' : ''}${d.shortLabel} (${availabilityCount(idx)}/${totalPlayers})`;

  // Ligne 1 : Semaine 1 - Lundi à Vendredi (indices 0 à 4)
  const rowDays1 = new ActionRowBuilder().addComponents(
    weekDays.slice(0, 5).map((d, idx) => {
      const isSelected = selectedSet.has(idx);
      return new ButtonBuilder()
        .setCustomId(`toggle_day:${campaign.id}:${idx}`)
        .setLabel(buildDayLabel(d, idx, isSelected))
        .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary);
    })
  );

  // Ligne 2 : Semaine 1 - Samedi et Dimanche (indices 5 et 6)
  const rowDays2 = new ActionRowBuilder().addComponents(
    weekDays.slice(5, 7).map((d, offset) => {
      const idx = 5 + offset;
      const isSelected = selectedSet.has(idx);
      return new ButtonBuilder()
        .setCustomId(`toggle_day:${campaign.id}:${idx}`)
        .setLabel(buildDayLabel(d, idx, isSelected))
        .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary);
    })
  );

  // Ligne 3 : Semaine 2 - Lundi à Vendredi (indices 7 à 11)
  const rowDays3 = new ActionRowBuilder().addComponents(
    weekDays.slice(7, 12).map((d, offset) => {
      const idx = 7 + offset;
      const isSelected = selectedSet.has(idx);
      return new ButtonBuilder()
        .setCustomId(`toggle_day:${campaign.id}:${idx}`)
        .setLabel(buildDayLabel(d, idx, isSelected))
        .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary);
    })
  );

  // Ligne 4 : Semaine 2 - Samedi et Dimanche (indices 12 et 13)
  const rowDays4 = new ActionRowBuilder().addComponents(
    weekDays.slice(12, 14).map((d, offset) => {
      const idx = 12 + offset;
      const isSelected = selectedSet.has(idx);
      return new ButtonBuilder()
        .setCustomId(`toggle_day:${campaign.id}:${idx}`)
        .setLabel(buildDayLabel(d, idx, isSelected))
        .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary);
    })
  );

  // Ligne 5 : Actions globales ("Tous les jours", "Indisponible", "Valider")
  const isAllSelected = selectedSet.size === 14;
  const count = selectedSet.size;
  const rowActions = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`toggle_all:${campaign.id}`)
      .setLabel(isAllSelected ? 'Tout décocher' : 'Tous les jours')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`vote_unavailable_ask:${campaign.id}`)
      .setLabel('Indisponible')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`confirm_vote:${campaign.id}`)
      .setLabel(count > 0 ? `Valider (${count})` : 'Valider')
      .setStyle(ButtonStyle.Success)
      .setDisabled(count === 0)
  );

  return {
    content: `**${campaign.title}**\n🗓️ **Semaine 1 :** du ${weekDays[0].shortLabel} au ${weekDays[6].shortLabel}\n🗓️ **Semaine 2 :** du ${weekDays[7].shortLabel} au ${weekDays[13].shortLabel}\n👥 *Le chiffre entre parenthèses indique combien de joueurs sont disponibles ce jour-là.*`,
    components: [rowDays1, rowDays2, rowDays3, rowDays4, rowActions],
    allowedMentions: { parse: [] }
  };
}

/**
 * Panneau strictement réservé au MJ de la table (ou Administrateur).
 */
function buildMJControlPanel(campaign, allCampaigns = []) {
  const startDateISO = campaign.startDateISO || campaign.weekMondayISO || getMondayISO();
  const weekDays = getRollingDays(startDateISO, 14);
  const rows = [];

  const quickDaySelect = new StringSelectMenuBuilder()
    .setCustomId(`mj_set_day:${campaign.id}`)
    .setPlaceholder('Fixer la date manuellement...')
    .addOptions(
      weekDays.map(d => {
        const conflicting = allCampaigns.find(
          c => c.id !== campaign.id && c.status === 'confirmed' && c.confirmedDateISO === d.iso && campaignsConflict(c, campaign)
        );
        let label = campaign.time ? `${d.fullLabel} (${campaign.time})` : d.fullLabel;
        if (conflicting) {
          label = `${d.shortLabel} (⛔ Pris par ${conflicting.title})`;
        }
        return {
          label: label.slice(0, 100),
          value: d.iso,
          default: campaign.status === 'confirmed' && campaign.confirmedDateISO === d.iso,
          description: conflicting ? `Réservé par ${conflicting.title}`.slice(0, 100) : undefined
        };
      })
    );

  rows.push(new ActionRowBuilder().addComponents(quickDaySelect));

  if (campaign.status === 'confirmed') {
    const sessionRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mj_set_time:${campaign.id}`)
        .setLabel(campaign.time ? `Modifier l’heure (${campaign.time})` : '🕒 Définir l’heure')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`mj_session_done:${campaign.id}`)
        .setLabel('Session terminée')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`mj_clear_date:${campaign.id}`)
        .setLabel('Retirer la date')
        .setStyle(ButtonStyle.Danger)
    );
    rows.push(sessionRow);

    const statusRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mj_pause:${campaign.id}`)
        .setLabel('⏸️ Mettre en pause')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`mj_prep:${campaign.id}`)
        .setLabel('📝 Préparation MJ en cours')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`mj_delete:${campaign.id}`)
        .setLabel('Supprimer la table')
        .setStyle(ButtonStyle.Danger)
    );
    rows.push(statusRow);
  } else if (campaign.status === 'paused') {
    const pausedRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mj_resume_poll:${campaign.id}`)
        .setLabel('▶️ Reprendre le sondage')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`mj_prep:${campaign.id}`)
        .setLabel('📝 Préparation MJ en cours')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`mj_delete:${campaign.id}`)
        .setLabel('Supprimer la table')
        .setStyle(ButtonStyle.Danger)
    );
    rows.push(pausedRow);
  } else if (campaign.status === 'prep') {
    const prepRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mj_resume_poll:${campaign.id}`)
        .setLabel('▶️ Lancer le sondage')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`mj_pause:${campaign.id}`)
        .setLabel('⏸️ Mettre en pause')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`mj_delete:${campaign.id}`)
        .setLabel('Supprimer la table')
        .setStyle(ButtonStyle.Danger)
    );
    rows.push(prepRow);
  } else {
    // Statut 'poll' ou 'unavailable'
    const pollRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mj_pause:${campaign.id}`)
        .setLabel('⏸️ Mettre en pause')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`mj_prep:${campaign.id}`)
        .setLabel('📝 Préparation MJ en cours')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`mj_restart_poll:${campaign.id}`)
        .setLabel('🔄 Réinitialiser le sondage')
        .setStyle(ButtonStyle.Secondary)
    );
    rows.push(pollRow);

    if (campaign.status === 'poll') {
      const nudgeRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`mj_nudge:${campaign.id}`)
          .setLabel('🔔 Relancer les retardataires')
          .setStyle(ButtonStyle.Primary)
      );
      rows.push(nudgeRow);
    }

    const deleteRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`mj_delete:${campaign.id}`)
        .setLabel('Supprimer la table')
        .setStyle(ButtonStyle.Danger)
    );
    rows.push(deleteRow);
  }

  let statusBadge = 'Sondage en cours';
  if (campaign.status === 'confirmed') statusBadge = 'Date confirmée';
  if (campaign.status === 'paused') statusBadge = 'Table en pause';
  if (campaign.status === 'prep') statusBadge = 'Préparation MJ en cours';
  if (campaign.status === 'unavailable') statusBadge = 'Joueurs non disponibles';

  return {
    content: `**${campaign.title}** — Gestion MJ (Statut : *${statusBadge}*)`,
    components: rows,
    allowedMentions: { parse: [] }
  };
}

/**
 * Traite le résultat d'un vote joueur (validation des jours ou clic sur "Semaine prochaine")
 */
async function processVoteSubmission(client, interaction, guildId, initialCampaign, selectedValues) {
  // Accuse réception immédiatement (Discord impose 3 s) : le traitement réel peut attendre son tour
  await interaction.deferUpdate();

  // File d'attente par serveur : les votes simultanés sont traités l'un après l'autre,
  // chacun voyant l'état à jour laissé par le précédent.
  await runExclusive(`mutation:${guildId}`, () =>
    processVoteSubmissionLocked(client, interaction, guildId, initialCampaign.id, selectedValues)
  );
}

async function processVoteSubmissionLocked(client, interaction, guildId, campaignId, selectedValues) {
  // Relit l'état à jour : le sondage a pu se clôturer pendant l'attente dans la file
  const { guild: currentGuild } = getGuildState(guildId);
  const campaign = currentGuild.campaigns.find(c => c.id === campaignId);
  if (!campaign || campaign.status !== 'poll') {
    await interaction.editReply({ content: 'Ce sondage n’est plus actif.', components: [] });
    return;
  }

  const discordGuild = await client.guilds.fetch(guildId);
  const rolePlayers = await getRolePlayers(discordGuild, campaign);
  const roleMemberIds = rolePlayers.map(p => p.id);

  const result = submitPlayerVote(
    guildId,
    campaign.id,
    interaction.user.id,
    selectedValues,
    roleMemberIds
  );

  draftSelections.delete(getDraftKey(campaign.id, interaction.user.id));

  await refreshDashboardMessage(client, guildId);

  if (result.event === 'AUTO_CONFIRMED') {
    const dateStr = formatFullDateFR(result.campaign.confirmedDateISO);
    const timeInfo = result.campaign.time ? ` à ${result.campaign.time}` : '';
    await sendRolePing(
      client,
      guildId,
      result.campaign,
      `Session validée pour **${result.campaign.title}** : **${dateStr}${timeInfo}**.`
    );
    await interaction.editReply({
      content: `Session validée : **${dateStr}${timeInfo}**.`,
      components: []
    });
  } else if (result.event === 'AUTO_CONFIRMED_WITH_SWAP') {
    const oldDateStr = formatFullDateFR(result.swappedOldDateISO);
    const newDateStr = formatFullDateFR(result.swappedNewDateISO);
    const swappedTimeInfo = result.swappedCampaign.time ? ` à ${result.swappedCampaign.time}` : '';

    // Notifie la table déplacée en expliquant l'arbitrage automatique
    await sendRolePing(
      client,
      guildId,
      result.swappedCampaign,
      `🔄 **Ajustement de planning automatique :**\nLa session de **${result.swappedCampaign.title}** a été déplacée au **${newDateStr}${swappedTimeInfo}** afin de libérer le **${oldDateStr}** pour **${result.campaign.title}** (qui n'avait qu'un seul jour possible).\nLes deux tables peuvent ainsi jouer ! 🎉`
    );

    // Notifie la table confirmée
    const dateStr = formatFullDateFR(result.campaign.confirmedDateISO);
    const timeInfo = result.campaign.time ? ` à ${result.campaign.time}` : '';
    await sendRolePing(
      client,
      guildId,
      result.campaign,
      `Session validée pour **${result.campaign.title}** : **${dateStr}${timeInfo}**.`
    );

    await interaction.editReply({
      content: `Session validée : **${dateStr}${timeInfo}** *(planning optimisé avec ${result.swappedCampaign.title})*.`,
      components: []
    });
  } else if (result.event === 'SHIFTED_NEXT_WEEK') {
    const startDateISO = result.campaign.startDateISO || result.campaign.weekMondayISO || getMondayISO();
    const nextDays = getRollingDays(startDateISO, 14);
    let pingMsg = `Nouveau sondage de disponibilité pour **${result.campaign.title}** (du ${nextDays[0].fullLabel} au ${nextDays[13].fullLabel}).`;
    if (result.conflictReason === 'DATE_ALREADY_TAKEN' && result.conflictingCampaignNames?.length > 0) {
      pingMsg = `⚠️ **Conflit de date :** Le créneau commun était déjà réservé par **${result.conflictingCampaignNames.join(', ')}**.\n${pingMsg}`;
    }
    await sendRolePing(
      client,
      guildId,
      result.campaign,
      pingMsg
    );
    const updatedPanel = buildPlayerVotePanel(result.campaign, interaction.user.id);
    await interaction.editReply({
      ...updatedPanel,
      content: `**${result.campaign.title}** — Du ${nextDays[0].fullLabel} au ${nextDays[13].fullLabel}`
    });
  } else if (result.event === 'UNAVAILABLE_2_WEEKS') {
    await deleteCampaignPing(client, guildId, result.campaign);
    const untilStr = formatDayMonthFR(result.campaign.unavailableUntilISO);
    let msg = `Joueurs non disponibles jusqu'au ${untilStr}.`;
    if (result.conflictReason === 'DATE_ALREADY_TAKEN' && result.conflictingCampaignNames?.length > 0) {
      msg = `Conflit de date avec **${result.conflictingCampaignNames.join(', ')}** : joueurs non disponibles sur un autre créneau jusqu'au ${untilStr}.`;
    }
    await interaction.editReply({
      content: msg,
      components: []
    });
  } else {
    await interaction.editReply({
      content: `Disponibilités enregistrées pour **${result.campaign.title}**.`,
      components: []
    });
  }
}

/**
 * Gère toutes les interactions Discord
 */
async function handleInteraction(client, interaction) {
  try {
    // =========================================================================
    // 1. SLASH COMMANDS (/jdr)
    // =========================================================================
    if (interaction.isChatInputCommand() && interaction.commandName === 'jdr') {
      const sub = interaction.options.getSubcommand();
      const guildId = interaction.guildId;

      if (sub === 'salon') {
        const channel = interaction.options.getChannel('salon', true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        setGuildChannel(guildId, channel.id, null);
        await refreshDashboardMessage(client, guildId);
        await interaction.editReply({ content: `Salon configuré sur <#${channel.id}>.` });
        return;
      }

      if (sub === 'creer') {
        const title = interaction.options.getString('nom', true);
        const role = interaction.options.getRole('role', true);
        const mjUser = interaction.options.getUser('mj');
        const theme = interaction.options.getString('theme') || 'fantasy';
        const bannerAttachment = interaction.options.getAttachment('banniere');

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const { guild: guildData } = getGuildState(guildId);
        if (!guildData.channelId) {
          setGuildChannel(guildId, interaction.channelId, null);
        }

        let bannerUrl = bannerAttachment ? bannerAttachment.url : null;
        let bannerMessageId = null;
        let bannerChannelId = null;

        if (bannerAttachment && client) {
          try {
            const res = await fetch(bannerAttachment.url);
            if (res.ok) {
              const arrayBuf = await res.arrayBuffer();
              const buffer = Buffer.from(arrayBuf);
              const { AttachmentBuilder } = require('discord.js');
              const att = new AttachmentBuilder(buffer, { name: 'banner_.png' });
              const dmContent = `[Bannière de votre JDR archivée en DM pour conservation permanente]\nTable : **${title}**`;
              let sentMsg = await interaction.user.send({ content: dmContent, files: [att] }).catch(() => null);

              if (!sentMsg) {
                const { getBotOwnerUser } = require('../storage/discordBackup');
                const ownerUser = await getBotOwnerUser(client);
                if (ownerUser) {
                  sentMsg = await ownerUser.send({ content: dmContent, files: [att] }).catch(() => null);
                }
              }

              if (sentMsg && sentMsg.attachments.first()) {
                bannerUrl = sentMsg.attachments.first().url;
                bannerMessageId = sentMsg.id;
                bannerChannelId = sentMsg.channelId;
              }
            }
          } catch (err) {
            console.error('[Creer] Erreur archivage bannière en DM:', err?.message);
          }
        }

        const campaign = createCampaign(guildId, {
          title,
          mjId: mjUser ? mjUser.id : interaction.user.id,
          mjName: mjUser
            ? (interaction.guild.members.cache.get(mjUser.id)?.displayName || mjUser.username)
            : (interaction.member ? interaction.member.displayName : interaction.user.username),
          roleId: role.id,
          roleName: `@${role.name}`,
          roleColor: role.hexColor !== '#000000' ? role.hexColor : '#f59e0b',
          theme,
          time: null,
          bannerUrl,
          bannerMessageId,
          bannerChannelId
        });

        // Mise à jour de l'affiche uniquement, sans poster de message supplémentaire dans le salon
        await refreshDashboardMessage(client, guildId);

        await interaction.editReply({
          content: `Table **${campaign.title}** créée avec le rôle <@&${role.id}>.`,
          allowedMentions: { parse: [] }
        });
        return;
      }

      if (sub === 'mj') {
        const role = interaction.options.getRole('role', true);
        const newMjUser = interaction.options.getUser('mj', true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const { guild: guildData } = getGuildState(guildId);
        const target = guildData.campaigns.find(c => c.roleId === role.id);
        if (!target) {
          await interaction.editReply({ content: `Aucune table associée au rôle <@&${role.id}>.` });
          return;
        }
        if (!isUserMJ(interaction, target)) {
          await interaction.editReply({ content: `Seul le MJ actuel ou un administrateur peut réassigner le MJ.` });
          return;
        }

        const member = interaction.guild.members.cache.get(newMjUser.id);
        const mjName = member ? member.displayName : newMjUser.username;
        updateCampaignConfig(guildId, target.id, { mjId: newMjUser.id, mjName });
        await refreshDashboardMessage(client, guildId);
        await interaction.editReply({
          content: `Le nouveau MJ de **${target.title}** est maintenant <@${newMjUser.id}>.`,
          allowedMentions: { parse: [] }
        });
        return;
      }

      if (sub === 'banniere') {
        const role = interaction.options.getRole('role', true);
        const image = interaction.options.getAttachment('image', true);
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const { guild: guildData } = getGuildState(guildId);
        const target = guildData.campaigns.find(c => c.roleId === role.id);
        if (!target) {
          await interaction.editReply({ content: `Aucune table associée au rôle <@&${role.id}>.` });
          return;
        }
        if (!isUserMJ(interaction, target)) {
          await interaction.editReply({ content: `Seul le MJ de cette table peut modifier sa bannière.` });
          return;
        }

        const token = createCropSession(guildId, target.id, image.url, interaction.user.id);
        const appUrl = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || 'https://jdr-annonce.onrender.com').replace(/\/+$/, '');
        const cropUrl = appUrl + '/crop/' + token;
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setLabel('Recadrer la bannière')
            .setStyle(ButtonStyle.Link)
            .setURL(cropUrl)
        );
        await interaction.editReply({
          content: 'Clique sur le bouton ci-dessous pour choisir le cadrage de **' + target.title + '** :',
          components: [row]
        });
        return;
      }
    }

    // =========================================================================
    // 2. BOUTONS DIRECTS JOUEUR ET MJ SOUS CHAQUE CARTE JDR (Option B)
    // =========================================================================
    if (interaction.isButton() && interaction.customId.startsWith('vote_open:')) {
      const campaignId = interaction.customId.split(':')[1];
      const guildId = interaction.guildId;
      let { guild: guildData } = getGuildState(guildId);
      let campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign) {
        const restored = await restoreBackupFromDiscord(client, guildId);
        if (restored) {
          guildData = restored;
          campaign = guildData.campaigns.find(c => c.id === campaignId);
        }
      }

      if (!campaign && interaction.message) {
        const restored = await tryRestoreStateFromMessage(guildId, interaction.message);
        if (restored) {
          guildData = restored;
          campaign = guildData.campaigns.find(c => c.id === campaignId);
        }
      }

      if (!campaign) {
        await interaction.reply({
          content: 'Cette table n’existe plus. Vous pouvez en créer une nouvelle avec `/jdr creer`.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (!isUserInRole(interaction, campaign)) {
        await interaction.reply({
          content: `Seuls les joueurs possédant le rôle <@&${campaign.roleId}> peuvent voter sur cette table.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] }
        });
        return;
      }

      if (campaign.status === 'confirmed' && campaign.confirmedDateISO) {
        const dateStr = formatFullDateFR(campaign.confirmedDateISO);
        const timeInfo = campaign.time ? ` à ${campaign.time}` : '';
        await interaction.reply({
          content: `La prochaine session pour **${campaign.title}** est déjà fixée au **${dateStr}${timeInfo}**.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (campaign.status === 'paused') {
        await interaction.reply({
          content: `La table **${campaign.title}** est actuellement en pause. Le MJ préviendra lors de la reprise des sessions !`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (campaign.status === 'prep') {
        await interaction.reply({
          content: `Le MJ est actuellement en **préparation de session** pour **${campaign.title}**. Le sondage sera lancé dès qu'il sera prêt !`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (campaign.status === 'unavailable' && campaign.unavailableUntilISO) {
        const untilStr = formatDayMonthFR(campaign.unavailableUntilISO);
        await interaction.reply({
          content: `Les joueurs ne sont pas disponibles pour **${campaign.title}** jusqu'au **${untilStr}**. Le MJ peut relancer le sondage à tout moment via son espace MJ.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (campaign.status !== 'poll') {
        await interaction.reply({
          content: `Aucun sondage en cours pour **${campaign.title}**.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      draftSelections.delete(getDraftKey(campaign.id, interaction.user.id));
      const playerPanel = buildPlayerVotePanel(campaign, interaction.user.id);
      await interaction.reply({
        ...playerPanel,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('mj_open:')) {
      const campaignId = interaction.customId.split(':')[1];
      const guildId = interaction.guildId;
      let { guild: guildData } = getGuildState(guildId);
      let campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign) {
        const restored = await restoreBackupFromDiscord(client, guildId);
        if (restored) {
          guildData = restored;
          campaign = guildData.campaigns.find(c => c.id === campaignId);
        }
      }

      if (!campaign && interaction.message) {
        const restored = await tryRestoreStateFromMessage(guildId, interaction.message);
        if (restored) {
          guildData = restored;
          campaign = guildData.campaigns.find(c => c.id === campaignId);
        }
      }

      if (!campaign) {
        await interaction.reply({
          content: 'Cette table n’existe plus. Vous pouvez en créer une nouvelle avec `/jdr creer`.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (!isUserMJ(interaction, campaign)) {
        await interaction.reply({
          content: `Action réservée au MJ de cette table (<@${campaign.mjId}>) ou à un administrateur.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] }
        });
        return;
      }

      const mjPanel = buildMJControlPanel(campaign, guildData.campaigns);
      await interaction.reply({
        ...mjPanel,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // =========================================================================
    // 2b. SÉLECTION D'UNE TABLE PAR UN JOUEUR (MENU DÉROULANT LEGACY)
    // =========================================================================
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_campaign') {
      const guildId = interaction.guildId;
      const campaignId = interaction.values[0];
      let { guild: guildData } = getGuildState(guildId);
      let campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign) {
        const restored = await restoreBackupFromDiscord(client, guildId);
        if (restored) {
          guildData = restored;
          campaign = guildData.campaigns.find(c => c.id === campaignId);
        }
      }

      if (!campaign && interaction.message) {
        const restored = await tryRestoreStateFromMessage(guildId, interaction.message);
        if (restored) {
          guildData = restored;
          campaign = guildData.campaigns.find(c => c.id === campaignId);
        }
      }

      if (!campaign) {
        await interaction.reply({
          content: 'Cette table n’existe plus. Vous pouvez en créer une nouvelle avec `/jdr creer`.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (!isUserInRole(interaction, campaign)) {
        await interaction.reply({
          content: `Seuls les joueurs possédant le rôle <@&${campaign.roleId}> peuvent voter sur cette table.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] }
        });
        return;
      }

      if (campaign.status !== 'poll') {
        await interaction.reply({
          content: `Aucun sondage en cours pour **${campaign.title}**.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      draftSelections.delete(getDraftKey(campaign.id, interaction.user.id));
      const playerPanel = buildPlayerVotePanel(campaign, interaction.user.id);
      await interaction.reply({
        ...playerPanel,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // =========================================================================
    // 3. BOUTONS DE SÉLECTION MULTI-JOURS JOUEUR (TOGGLE SANS FERMER LE MENU)
    // =========================================================================
    if (interaction.isButton() && interaction.customId.startsWith('toggle_day:')) {
      const [, campaignId, dayIdxStr] = interaction.customId.split(':');
      const dayIdx = parseInt(dayIdxStr, 10);
      const { guild: guildData } = getGuildState(interaction.guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign || campaign.status !== 'poll') {
        await interaction.update({ content: 'Ce sondage n’est plus actif.', components: [] });
        return;
      }

      const selectedSet = getOrInitDraft(campaign, interaction.user.id);
      if (selectedSet.has(dayIdx)) {
        selectedSet.delete(dayIdx);
      } else {
        selectedSet.add(dayIdx);
      }

      const updatedPanel = buildPlayerVotePanel(campaign, interaction.user.id);
      await interaction.update(updatedPanel);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('toggle_all:')) {
      const [, campaignId] = interaction.customId.split(':');
      const { guild: guildData } = getGuildState(interaction.guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign || campaign.status !== 'poll') {
        await interaction.update({ content: 'Ce sondage n’est plus actif.', components: [] });
        return;
      }

      const selectedSet = getOrInitDraft(campaign, interaction.user.id);
      if (selectedSet.size === 14) {
        selectedSet.clear();
      } else {
        Array.from({ length: 14 }, (_, i) => i).forEach(i => selectedSet.add(i));
      }

      const updatedPanel = buildPlayerVotePanel(campaign, interaction.user.id);
      await interaction.update(updatedPanel);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('confirm_vote:')) {
      const [, campaignId] = interaction.customId.split(':');
      const guildId = interaction.guildId;
      const { guild: guildData } = getGuildState(guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign || campaign.status !== 'poll') {
        await interaction.update({ content: 'Ce sondage n’est plus actif.', components: [] });
        return;
      }

      if (!isUserInRole(interaction, campaign)) {
        await interaction.update({
          content: `Seuls les membres du rôle <@&${campaign.roleId}> ont le droit de voter.`,
          components: [],
          allowedMentions: { parse: [] }
        });
        return;
      }

      const selectedSet = getOrInitDraft(campaign, interaction.user.id);
      const selectedValues = Array.from(selectedSet).sort((a, b) => a - b).map(String);
      await processVoteSubmission(client, interaction, guildId, campaign, selectedValues);
      return;
    }

    if (
      interaction.isButton() &&
      (interaction.customId.startsWith('vote_unavailable_ask:') ||
        interaction.customId.startsWith('vote_next_week:'))
    ) {
      const parts = interaction.customId.split(':');
      const campaignId = parts[1];
      const guildId = interaction.guildId;
      const { guild: guildData } = getGuildState(guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign || campaign.status !== 'poll') {
        await interaction.update({ content: 'Ce sondage n’est plus actif.', components: [] });
        return;
      }

      if (!isUserInRole(interaction, campaign)) {
        await interaction.update({
          content: `Seuls les membres du rôle <@&${campaign.roleId}> ont le droit de voter.`,
          components: [],
          allowedMentions: { parse: [] }
        });
        return;
      }

      // Demande de confirmation sécurisée demandée par l'utilisateur
      const rowConfirm = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`vote_unavailable_confirm:${campaign.id}`)
          .setLabel('Confirmer l’indisponibilité')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId(`vote_unavailable_cancel:${campaign.id}`)
          .setLabel('Annuler')
          .setStyle(ButtonStyle.Secondary)
      );

      await interaction.update({
        content: `⚠️ **Si vous choisissez cela, cela clôturera le sondage pour cette période.**`,
        components: [rowConfirm]
      });
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vote_unavailable_cancel:')) {
      const [, campaignId] = interaction.customId.split(':');
      const guildId = interaction.guildId;
      const { guild: guildData } = getGuildState(guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign || campaign.status !== 'poll') {
        await interaction.update({ content: 'Ce sondage n’est plus actif.', components: [] });
        return;
      }

      const playerPanel = buildPlayerVotePanel(campaign, interaction.user.id);
      await interaction.update(playerPanel);
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('vote_unavailable_confirm:')) {
      const [, campaignId] = interaction.customId.split(':');
      const guildId = interaction.guildId;
      const { guild: guildData } = getGuildState(guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign || campaign.status !== 'poll') {
        await interaction.update({ content: 'Ce sondage n’est plus actif.', components: [] });
        return;
      }

      if (!isUserInRole(interaction, campaign)) {
        await interaction.update({
          content: `Seuls les membres du rôle <@&${campaign.roleId}> ont le droit de voter.`,
          components: [],
          allowedMentions: { parse: [] }
        });
        return;
      }

      await processVoteSubmission(client, interaction, guildId, campaign, ['UNAVAILABLE']);
      return;
    }

    // =========================================================================
    // 4. OUVERTURE DE L'ESPACE MJ (BOUTON SÉPARÉ RÉSERVÉ AU MJ / ADMIN)
    // =========================================================================
    if (interaction.isButton() && interaction.customId === 'open_mj_menu') {
      const guildId = interaction.guildId;
      let { guild: guildData } = getGuildState(guildId);

      if ((!guildData.campaigns || guildData.campaigns.length === 0) && interaction.message) {
        const restored = await tryRestoreStateFromMessage(guildId, interaction.message);
        if (restored) guildData = restored;
      }

      const isAdmin =
        interaction.memberPermissions &&
        (interaction.memberPermissions.has(PermissionFlagsBits.Administrator) ||
          interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild));
      const mjCampaigns = (guildData.campaigns || []).filter(
        c => c.mjId === interaction.user.id || isAdmin
      );

      if (mjCampaigns.length === 0) {
        await interaction.reply({
          content: 'Seul le MJ d’une table (ou un administrateur) peut accéder à cet espace.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (mjCampaigns.length === 1) {
        const mjPanel = buildMJControlPanel(mjCampaigns[0], guildData.campaigns);
        await interaction.reply({
          ...mjPanel,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const selectMjTable = new StringSelectMenuBuilder()
        .setCustomId('select_mj_campaign')
        .setPlaceholder('Choisir la table à gérer...')
        .addOptions(
          mjCampaigns.slice(0, 25).map(c => ({
            label: c.title.slice(0, 100),
            value: c.id
          }))
        );

      await interaction.reply({
        components: [new ActionRowBuilder().addComponents(selectMjTable)],
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'select_mj_campaign') {
      const guildId = interaction.guildId;
      const campaignId = interaction.values[0];
      const { guild: guildData } = getGuildState(guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign || !isUserMJ(interaction, campaign)) {
        await interaction.update({ content: 'Action réservée au MJ.', components: [] });
        return;
      }

      const mjPanel = buildMJControlPanel(campaign, guildData.campaigns);
      await interaction.update(mjPanel);
      return;
    }

    // =========================================================================
    // 5. ACTIONS DU MJ (DÉFINIR LE JOUR, RELANCER SONDAGE, TERMINER, SUPPRIMER)
    // =========================================================================
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('mj_set_day:')) {
      const guildId = interaction.guildId;
      const campaignId = interaction.customId.split(':')[1];
      const selectedDateISO = interaction.values[0];
      const { guild: guildData } = getGuildState(guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign || !isUserMJ(interaction, campaign)) {
        await interaction.update({ content: 'Action réservée au MJ.', components: [] });
        return;
      }

      await interaction.deferUpdate();
      // Les actions MJ passent par la même file d'attente que les votes (aucune course d'état)
      await runExclusive(`mutation:${guildId}`, async () => {
      const setResult = setManualSessionDate(guildId, campaignId, selectedDateISO);

      if (!setResult.success) {
        if (setResult.error === 'DATE_ALREADY_TAKEN') {
          const dateStr = formatFullDateFR(selectedDateISO);
          await interaction.editReply({
            content: `⛔ **Date indisponible :** Le **${dateStr}** est déjà réservé par la table **${setResult.conflictingCampaign.title}**.\nVeuillez choisir un autre jour pour éviter que deux sessions tombent le même jour.`,
            components: []
          });
          return;
        }
        await interaction.editReply({ content: 'Erreur lors de la configuration de la date.', components: [] });
        return;
      }

      const updated = setResult.campaign;
      await refreshDashboardMessage(client, guildId);

      const dateStr = formatFullDateFR(updated.confirmedDateISO);
      const timeInfo = updated.time ? ` à ${updated.time}` : '';
      await sendRolePing(
        client,
        guildId,
        updated,
        `Session fixée pour **${updated.title}** : **${dateStr}${timeInfo}**.`
      );

      await interaction.editReply({
        content: `Date fixée au **${dateStr}${timeInfo}**.`,
        components: []
      });
      });
      return;
    }

    // =========================================================================
    // 5b. DÉFINITION DE L'HEURE PAR LE MJ (OUVERTURE MODAL & VALIDATION)
    // =========================================================================
    if (interaction.isButton() && interaction.customId.startsWith('mj_set_time:')) {
      const campaignId = interaction.customId.split(':')[1];
      const guildId = interaction.guildId;
      const { guild: guildData } = getGuildState(guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign || !isUserMJ(interaction, campaign)) {
        await interaction.reply({ content: 'Action réservée au MJ.', flags: MessageFlags.Ephemeral });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`set_time_modal:${campaignId}`)
        .setTitle(`Heure - ${campaign.title.slice(0, 35)}`);

      const timeInput = new TextInputBuilder()
        .setCustomId('session_time_input')
        .setLabel('Heure de début (informatif)')
        .setPlaceholder('ex: 20h30, 21h00, 14h00, après manger...')
        .setStyle(TextInputStyle.Short)
        .setValue(campaign.time || '')
        .setRequired(true)
        .setMaxLength(40);

      modal.addComponents(new ActionRowBuilder().addComponents(timeInput));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('set_time_modal:')) {
      const campaignId = interaction.customId.split(':')[1];
      const guildId = interaction.guildId;
      const { guild: guildData } = getGuildState(guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign || !isUserMJ(interaction, campaign)) {
        await interaction.reply({ content: 'Action réservée au MJ.', flags: MessageFlags.Ephemeral });
        return;
      }

      const rawTime = interaction.fields.getTextInputValue('session_time_input').trim();
      updateCampaignConfig(guildId, campaignId, { time: rawTime });
      await refreshDashboardMessage(client, guildId);

      const dateStr = campaign.confirmedDateISO ? formatFullDateFR(campaign.confirmedDateISO) : 'la session';
      await interaction.reply({
        content: `Heure fixée à **${rawTime}** pour ${dateStr} (**${campaign.title}**).\nL'affiche a été mise à jour !`,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    if (interaction.isButton()) {
      const [action, campaignId] = interaction.customId.split(':');
      if (!campaignId) return;

      const guildId = interaction.guildId;
      const { guild: guildData } = getGuildState(guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign || !isUserMJ(interaction, campaign)) {
        await interaction.reply({
          content: 'Action réservée au MJ de cette table.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.deferUpdate();

      // Toutes les actions MJ sont sérialisées avec les votes pour ce serveur
      await runExclusive(`mutation:${guildId}`, async () => {
      // Relit la table à jour (elle a pu changer pendant l'attente dans la file)
      const campaign = getGuildState(guildId).guild.campaigns.find(c => c.id === campaignId);
      if (!campaign) {
        await interaction.editReply({ content: 'Cette table n’existe plus.', components: [] });
        return;
      }

      if (action === 'mj_nudge') {
        const nudge = await sendLateVotersNudge(client, guildId, campaignId);
        let message = 'Impossible d’envoyer la relance.';
        if (nudge.status === 'SENT') {
          message = `🔔 Relance envoyée à **${nudge.missingCount}** joueur(s) n’ayant pas encore voté (sur ${nudge.totalCount}).`;
        } else if (nudge.status === 'NONE_MISSING') {
          message = 'Tous les joueurs ont déjà voté, aucune relance nécessaire.';
        } else if (nudge.status === 'COOLDOWN') {
          const retryTs = Math.ceil(nudge.retryAt / 1000);
          message = `Une relance a déjà été envoyée récemment. Nouvelle relance possible <t:${retryTs}:R>.`;
        } else if (nudge.status === 'NOT_POLLING') {
          message = 'Aucun sondage en cours pour cette table.';
        } else if (nudge.status === 'NO_CHANNEL') {
          message = 'Le salon du tableau n’est pas configuré ou est inaccessible.';
        }
        await interaction.editReply({ content: message, components: [] });
        return;
      }

      if (action === 'mj_pause') {
        await deleteCampaignPing(client, guildId, campaign);
        const updated = setCampaignStatus(guildId, campaignId, 'paused');
        await refreshDashboardMessage(client, guildId);
        await interaction.editReply({
          content: `Table **${updated.title}** mise en pause. Le sondage est arrêté et l'affiche indique la pause.`,
          components: []
        });
        return;
      }

      if (action === 'mj_prep') {
        await deleteCampaignPing(client, guildId, campaign);
        const updated = setCampaignStatus(guildId, campaignId, 'prep');
        await refreshDashboardMessage(client, guildId);
        await interaction.editReply({
          content: `Table **${updated.title}** passée en **Préparation MJ en cours**. L'affiche a été mise à jour.`,
          components: []
        });
        return;
      }

      if (action === 'mj_resume_poll') {
        const updated = setCampaignStatus(guildId, campaignId, 'poll');
        await refreshDashboardMessage(client, guildId);
        const startDateISO = updated.startDateISO || updated.weekMondayISO || getMondayISO();
        const weekDays = getRollingDays(startDateISO, 14);
        await sendRolePing(
          client,
          guildId,
          updated,
          `Sondage de disponibilité ouvert pour **${updated.title}** (du ${weekDays[0].fullLabel} au ${weekDays[13].fullLabel}).`
        );
        await interaction.editReply({
          content: `Sondage lancé pour **${updated.title}** (du ${weekDays[0].fullLabel} au ${weekDays[13].fullLabel}).`,
          components: []
        });
        return;
      }

      if (action === 'mj_restart_poll') {
        const updated = restartCampaignPoll(guildId, campaignId, { nextWeek: false });
        await refreshDashboardMessage(client, guildId);
        const startDateISO = updated.startDateISO || updated.weekMondayISO || getMondayISO();
        const weekDays = getRollingDays(startDateISO, 14);
        await sendRolePing(
          client,
          guildId,
          updated,
          `Nouveau sondage de disponibilité pour **${updated.title}** (du ${weekDays[0].fullLabel} au ${weekDays[13].fullLabel}).`
        );
        await interaction.editReply({
          content: `Sondage relancé pour **${updated.title}** (du ${weekDays[0].fullLabel} au ${weekDays[13].fullLabel}).`,
          components: []
        });
        return;
      }

      if (action === 'mj_session_done') {
        const updated = restartCampaignPoll(guildId, campaignId, { nextWeek: true });
        await refreshDashboardMessage(client, guildId);
        const startDateISO = updated.startDateISO || updated.weekMondayISO || getMondayISO();
        const weekDays = getRollingDays(startDateISO, 14);
        await sendRolePing(
          client,
          guildId,
          updated,
          `Nouveau sondage de disponibilité pour **${updated.title}** (du ${weekDays[0].fullLabel} au ${weekDays[13].fullLabel}).`
        );
        await interaction.editReply({
          content: `Nouveau sondage lancé pour la période du **${weekDays[0].fullLabel}** au **${weekDays[13].fullLabel}**.`,
          components: []
        });
        return;
      }

      if (action === 'mj_clear_date') {
        await deleteCampaignPing(client, guildId, campaign);
        const updated = clearSessionDate(guildId, campaignId);
        await refreshDashboardMessage(client, guildId);
        await interaction.editReply({
          content: `Date retirée pour **${updated.title}**.`,
          components: []
        });
        return;
      }

      if (action === 'mj_delete') {
        await deleteCampaignPing(client, guildId, campaign);
        await removeCampaignEvent(client, guildId, campaign);
        const removed = deleteCampaign(guildId, campaignId);
        await refreshDashboardMessage(client, guildId);
        await interaction.editReply({
          content: `Table **${removed ? removed.title : ''}** supprimée.`,
          components: []
        });
        return;
      }
      });
    }
  } catch (err) {
    console.error('Erreur interaction Discord:', err);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: 'Une erreur est survenue.',
        flags: MessageFlags.Ephemeral
      }).catch(() => null);
    }
  }
}

module.exports = {
  getSlashCommands,
  handleInteraction
};
