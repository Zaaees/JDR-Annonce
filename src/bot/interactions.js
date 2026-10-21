const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags
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
  restartCampaignPoll
} = require('../storage/store');
const {
  getWeekDaysFromMonday,
  formatFullDateFR,
  formatDayMonthFR
} = require('../utils/dates');
const {
  getRolePlayers,
  refreshDashboardMessage,
  tryRestoreStateFromMessage,
  sendRolePing
} = require('./dashboardManager');
const { createCropSession } = require('../server/cropServer');

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
        .addStringOption(opt =>
          opt.setName('heure').setDescription('Heure par défaut (ex: 21h00)').setRequired(false)
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
  return interaction.user.id === campaign.mjId;
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
 * sans fermeture automatique, + bouton "Semaine prochaine" et bouton "Valider".
 */
function buildPlayerVotePanel(campaign, userId) {
  const weekDays = getWeekDaysFromMonday(campaign.weekMondayISO);
  const selectedSet = getOrInitDraft(campaign, userId);

  // Ligne 1 : Lundi, Mardi, Mercredi, Jeudi (indices 0 à 3)
  const rowDays1 = new ActionRowBuilder().addComponents(
    weekDays.slice(0, 4).map((d, idx) => {
      const isSelected = selectedSet.has(idx);
      return new ButtonBuilder()
        .setCustomId(`toggle_day:${campaign.id}:${idx}`)
        .setLabel(isSelected ? `✓ ${d.shortLabel}` : d.shortLabel)
        .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary);
    })
  );

  // Ligne 2 : Vendredi, Samedi, Dimanche (indices 4 à 6)
  const rowDays2 = new ActionRowBuilder().addComponents(
    weekDays.slice(4, 7).map((d, offset) => {
      const idx = 4 + offset;
      const isSelected = selectedSet.has(idx);
      return new ButtonBuilder()
        .setCustomId(`toggle_day:${campaign.id}:${idx}`)
        .setLabel(isSelected ? `✓ ${d.shortLabel}` : d.shortLabel)
        .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary);
    })
  );

  // Ligne 3 : Options globales "Toute la semaine" et "Semaine prochaine"
  const rowActions = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`toggle_all:${campaign.id}`)
      .setLabel(selectedSet.size === 7 ? 'Tout décocher' : 'Toute la semaine')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`vote_next_week:${campaign.id}`)
      .setLabel('Semaine prochaine')
      .setStyle(ButtonStyle.Danger)
  );

  // Ligne 4 : Bouton Valider mes disponibilités
  const count = selectedSet.size;
  const rowConfirm = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`confirm_vote:${campaign.id}`)
      .setLabel(count > 0 ? `Valider mes disponibilités (${count})` : 'Valider mes disponibilités')
      .setStyle(ButtonStyle.Success)
      .setDisabled(count === 0)
  );

  return {
    content: `**${campaign.title}**`,
    components: [rowDays1, rowDays2, rowActions, rowConfirm],
    allowedMentions: { parse: [] }
  };
}

/**
 * Panneau strictement réservé au MJ de la table.
 */
function buildMJControlPanel(campaign) {
  const weekDays = getWeekDaysFromMonday(campaign.weekMondayISO);
  const rows = [];

  const quickDaySelect = new StringSelectMenuBuilder()
    .setCustomId(`mj_set_day:${campaign.id}`)
    .setPlaceholder('Définir la date de la session...')
    .addOptions(
      weekDays.map(d => ({
        label: `${d.fullLabel} (${campaign.time})`,
        value: d.iso,
        default: campaign.status === 'confirmed' && campaign.confirmedDateISO === d.iso
      }))
    );

  rows.push(new ActionRowBuilder().addComponents(quickDaySelect));

  const btnRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`mj_restart_poll:${campaign.id}`)
      .setLabel('Relancer le sondage')
      .setStyle(ButtonStyle.Secondary)
  );

  if (campaign.status === 'confirmed') {
    btnRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`mj_session_done:${campaign.id}`)
        .setLabel('Session terminée')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`mj_clear_date:${campaign.id}`)
        .setLabel('Retirer la date')
        .setStyle(ButtonStyle.Danger)
    );
  }

  btnRow.addComponents(
    new ButtonBuilder()
      .setCustomId(`mj_delete:${campaign.id}`)
      .setLabel('Supprimer la table')
      .setStyle(ButtonStyle.Danger)
  );

  rows.push(btnRow);

  return {
    content: `**${campaign.title}** — Gestion MJ`,
    components: rows,
    allowedMentions: { parse: [] }
  };
}

/**
 * Traite le résultat d'un vote joueur (validation des jours ou clic sur "Semaine prochaine")
 */
async function processVoteSubmission(client, interaction, guildId, campaign, selectedValues) {
  await interaction.deferUpdate();

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
    await sendRolePing(
      client,
      guildId,
      result.campaign,
      `Session validée pour **${result.campaign.title}** : **${dateStr} à ${result.campaign.time}**.`
    );
    await interaction.editReply({
      content: `Session validée : **${dateStr} à ${result.campaign.time}**.`,
      components: []
    });
  } else if (result.event === 'SHIFTED_NEXT_WEEK') {
    const nextWeekDays = getWeekDaysFromMonday(result.campaign.weekMondayISO);
    await sendRolePing(
      client,
      guildId,
      result.campaign,
      `Nouveau sondage de disponibilité pour **${result.campaign.title}** (semaine du ${nextWeekDays[0].fullLabel}).`
    );
    const updatedPanel = buildPlayerVotePanel(result.campaign, interaction.user.id);
    await interaction.editReply({
      ...updatedPanel,
      content: `**${result.campaign.title}** — Semaine du ${nextWeekDays[0].fullLabel}`
    });
  } else if (result.event === 'UNAVAILABLE_2_WEEKS') {
    const untilStr = formatDayMonthFR(result.campaign.unavailableUntilISO);
    await interaction.editReply({
      content: `Joueurs non disponibles jusqu'au ${untilStr}.`,
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
        const time = interaction.options.getString('heure') || '21h00';
        const theme = interaction.options.getString('theme') || 'fantasy';
        const bannerAttachment = interaction.options.getAttachment('banniere');

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const { guild: guildData } = getGuildState(guildId);
        if (!guildData.channelId) {
          setGuildChannel(guildId, interaction.channelId, null);
        }

        const campaign = createCampaign(guildId, {
          title,
          mjId: interaction.user.id,
          mjName: interaction.member ? interaction.member.displayName : interaction.user.username,
          roleId: role.id,
          roleName: `@${role.name}`,
          roleColor: role.hexColor !== '#000000' ? role.hexColor : '#f59e0b',
          theme,
          time,
          bannerUrl: bannerAttachment ? bannerAttachment.url : null
        });

        await refreshDashboardMessage(client, guildId);

        const weekDays = getWeekDaysFromMonday(campaign.weekMondayISO);
        await sendRolePing(
          client,
          guildId,
          campaign,
          `Nouveau sondage de disponibilité pour **${campaign.title}** (semaine du ${weekDays[0].fullLabel}).`
        );

        await interaction.editReply({
          content: `Table **${campaign.title}** créée avec le rôle <@&${role.id}>.`,
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

        const token = createCropSession(guildId, target.id, image.url);
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
    // 2. SÉLECTION D'UNE TABLE PAR UN JOUEUR
    // =========================================================================
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_campaign') {
      const guildId = interaction.guildId;
      const campaignId = interaction.values[0];
      let { guild: guildData } = getGuildState(guildId);
      let campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign && interaction.message) {
        const restored = await tryRestoreStateFromMessage(guildId, interaction.message);
        if (restored) {
          guildData = restored;
          campaign = guildData.campaigns.find(c => c.id === campaignId);
        }
      }

      if (!campaign) {
        await interaction.reply({
          content: 'Cette table n’existe plus.',
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

      // Réinitialise le brouillon avec les jours déjà votés par ce joueur
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
      if (selectedSet.size === 7) {
        selectedSet.clear();
      } else {
        [0, 1, 2, 3, 4, 5, 6].forEach(i => selectedSet.add(i));
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

    if (interaction.isButton() && interaction.customId.startsWith('vote_next_week:')) {
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

      await processVoteSubmission(client, interaction, guildId, campaign, ['NEXT_WEEK']);
      return;
    }

    // =========================================================================
    // 4. OUVERTURE DE L'ESPACE MJ (BOUTON SÉPARÉ RÉSERVÉ AU MJ)
    // =========================================================================
    if (interaction.isButton() && interaction.customId === 'open_mj_menu') {
      const guildId = interaction.guildId;
      let { guild: guildData } = getGuildState(guildId);

      if ((!guildData.campaigns || guildData.campaigns.length === 0) && interaction.message) {
        const restored = await tryRestoreStateFromMessage(guildId, interaction.message);
        if (restored) guildData = restored;
      }

      const mjCampaigns = (guildData.campaigns || []).filter(c => c.mjId === interaction.user.id);
      if (mjCampaigns.length === 0) {
        await interaction.reply({
          content: 'Seul le MJ créateur d’une table peut accéder à cet espace.',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (mjCampaigns.length === 1) {
        const mjPanel = buildMJControlPanel(mjCampaigns[0]);
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

      const mjPanel = buildMJControlPanel(campaign);
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
      const updated = setManualSessionDate(guildId, campaignId, selectedDateISO);
      await refreshDashboardMessage(client, guildId);

      const dateStr = formatFullDateFR(updated.confirmedDateISO);
      await sendRolePing(
        client,
        guildId,
        updated,
        `Session fixée pour **${updated.title}** : **${dateStr} à ${updated.time}**.`
      );

      await interaction.editReply({
        content: `Date fixée au **${dateStr} à ${updated.time}**.`,
        components: []
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

      if (action === 'mj_restart_poll') {
        const updated = restartCampaignPoll(guildId, campaignId, { nextWeek: false });
        await refreshDashboardMessage(client, guildId);
        const weekDays = getWeekDaysFromMonday(updated.weekMondayISO);
        await sendRolePing(
          client,
          guildId,
          updated,
          `Nouveau sondage de disponibilité pour **${updated.title}** (semaine du ${weekDays[0].fullLabel}).`
        );
        await interaction.editReply({
          content: `Sondage relancé pour **${updated.title}**.`,
          components: []
        });
        return;
      }

      if (action === 'mj_session_done') {
        const updated = restartCampaignPoll(guildId, campaignId, { nextWeek: true });
        await refreshDashboardMessage(client, guildId);
        const weekDays = getWeekDaysFromMonday(updated.weekMondayISO);
        await sendRolePing(
          client,
          guildId,
          updated,
          `Nouveau sondage de disponibilité pour **${updated.title}** (semaine du ${weekDays[0].fullLabel}).`
        );
        await interaction.editReply({
          content: `Nouveau sondage lancé pour la semaine du **${weekDays[0].fullLabel}**.`,
          components: []
        });
        return;
      }

      if (action === 'mj_clear_date') {
        const updated = clearSessionDate(guildId, campaignId);
        await refreshDashboardMessage(client, guildId);
        await interaction.editReply({
          content: `Date retirée pour **${updated.title}**.`,
          components: []
        });
        return;
      }

      if (action === 'mj_delete') {
        const removed = deleteCampaign(guildId, campaignId);
        await refreshDashboardMessage(client, guildId);
        await interaction.editReply({
          content: `Table **${removed ? removed.title : ''}** supprimée.`,
          components: []
        });
        return;
      }
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
