const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
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
  formatDayMonthFR,
  parseUserDateFR,
  parseTimeInput
} = require('../utils/dates');
const {
  getRolePlayers,
  refreshDashboardMessage,
  tryRestoreStateFromMessage,
  sendRolePing
} = require('./dashboardManager');

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
  if (interaction.user.id === campaign.mjId) return true;
  if (interaction.memberPermissions && interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
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
 * Construit le panneau éphémère lorsqu'un joueur ou le MJ sélectionne un JDR.
 * Aucun texte explicatif superflu : uniquement les sélecteurs et boutons d'action.
 */
function buildCampaignControlPanel(campaign, canVote, canManage) {
  const weekDays = getWeekDaysFromMonday(campaign.weekMondayISO);
  const rows = [];

  // 1. Sélection de vote pour les membres du @Rôle (si sondage ouvert)
  if (canVote && campaign.status === 'poll') {
    const existingVote = campaign.votes && Array.isArray(campaign.votes[canVote.userId])
      ? campaign.votes[canVote.userId]
      : [];

    const options = weekDays.map((d, idx) => ({
      label: d.fullLabel,
      value: String(idx),
      default: existingVote.includes(idx)
    }));

    // Ajout de "Semaine prochaine" directement dans la sélection avec les jours de la semaine
    options.push({
      label: 'Semaine prochaine',
      value: 'NEXT_WEEK'
    });

    const voteSelect = new StringSelectMenuBuilder()
      .setCustomId(`vote_days:${campaign.id}`)
      .setPlaceholder('Sélectionner mes disponibilités...')
      .setMinValues(1)
      .setMaxValues(options.length)
      .addOptions(options);

    rows.push(new ActionRowBuilder().addComponents(voteSelect));
  }

  // 2. Contrôles du MJ (choix rapide d'un jour de la semaine + boutons d'action)
  if (canManage) {
    const quickDaySelect = new StringSelectMenuBuilder()
      .setCustomId(`mj_set_day:${campaign.id}`)
      .setPlaceholder('Définir un jour de cette semaine...')
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
        .setCustomId(`mj_modal_date:${campaign.id}`)
        .setLabel('Autre date / heure')
        .setStyle(ButtonStyle.Primary),
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
    } else {
      btnRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`mj_delete:${campaign.id}`)
          .setLabel('Supprimer la table')
          .setStyle(ButtonStyle.Danger)
      );
    }

    rows.push(btnRow);
  }

  return {
    content: `**${campaign.title}** (<@&${campaign.roleId}>)`,
    components: rows,
    allowedMentions: { parse: [] }
  };
}

/**
 * Gère toutes les interactions Discord (Slash commands, SelectMenus, Buttons, Modals)
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

        updateCampaignConfig(guildId, target.id, { bannerUrl: image.url });
        await refreshDashboardMessage(client, guildId);
        await interaction.editReply({ content: `Bannière mise à jour pour **${target.title}**.` });
        return;
      }
    }

    // =========================================================================
    // 2. SÉLECTION D'UNE TABLE SUR LE MÉGA-DASHBOARD
    // =========================================================================
    if (interaction.isStringSelectMenu() && interaction.customId === 'select_campaign') {
      const guildId = interaction.guildId;
      const campaignId = interaction.values[0];
      let { guild: guildData } = getGuildState(guildId);
      let campaign = guildData.campaigns.find(c => c.id === campaignId);

      // Si Render a redémarré et que la mémoire locale était vide, restaure directement depuis l'image du message cliqué
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

      const memberHasRole = isUserInRole(interaction, campaign);
      const userIsMJ = isUserMJ(interaction, campaign);

      if (!memberHasRole && !userIsMJ) {
        await interaction.reply({
          content: `Seuls les membres du rôle <@&${campaign.roleId}> peuvent voter sur cette table.`,
          flags: MessageFlags.Ephemeral,
          allowedMentions: { parse: [] }
        });
        return;
      }

      const panel = buildCampaignControlPanel(
        campaign,
        memberHasRole ? { userId: interaction.user.id } : null,
        userIsMJ
      );

      if (panel.components.length === 0) {
        await interaction.reply({
          content: `**${campaign.title}** — Aucun sondage en cours.`,
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      await interaction.reply({
        ...panel,
        flags: MessageFlags.Ephemeral
      });
      return;
    }

    // =========================================================================
    // 3. VOTE D'UN JOUEUR DU @RÔLE (JOURS OU "SEMAINE PROCHAINE")
    // =========================================================================
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('vote_days:')) {
      const guildId = interaction.guildId;
      const campaignId = interaction.customId.split(':')[1];
      const { guild: guildData } = getGuildState(guildId);
      const campaign = guildData.campaigns.find(c => c.id === campaignId);

      if (!campaign) {
        await interaction.update({ content: 'Cette table n’existe plus.', components: [] });
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

      await interaction.deferUpdate();

      const discordGuild = await client.guilds.fetch(guildId);
      const rolePlayers = await getRolePlayers(discordGuild, campaign);
      const roleMemberIds = rolePlayers.map(p => p.id);

      const result = submitPlayerVote(
        guildId,
        campaignId,
        interaction.user.id,
        interaction.values,
        roleMemberIds
      );

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
        const updatedPanel = buildCampaignControlPanel(
          result.campaign,
          { userId: interaction.user.id },
          isUserMJ(interaction, result.campaign)
        );
        await interaction.editReply({
          ...updatedPanel,
          content: `Passage à la semaine du **${nextWeekDays[0].fullLabel}**.`
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
      return;
    }

    // =========================================================================
    // 4. ACTIONS DU MJ (CHOIX RAPIDE DU JOUR, BOUTONS & MODAL)
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

      if (action === 'mj_modal_date') {
        const modal = new ModalBuilder()
          .setCustomId(`modal_set_date:${campaign.id}`)
          .setTitle(`Date — ${campaign.title.slice(0, 30)}`);

        const dateInput = new TextInputBuilder()
          .setCustomId('date_input')
          .setLabel('Date (JJ/MM/AAAA)')
          .setPlaceholder('30/10/2026')
          .setRequired(true)
          .setStyle(TextInputStyle.Short);

        const timeInput = new TextInputBuilder()
          .setCustomId('time_input')
          .setLabel('Heure (ex: 21h00)')
          .setValue(campaign.time || '21h00')
          .setRequired(true)
          .setStyle(TextInputStyle.Short);

        modal.addComponents(
          new ActionRowBuilder().addComponents(dateInput),
          new ActionRowBuilder().addComponents(timeInput)
        );

        await interaction.showModal(modal);
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

    // =========================================================================
    // 5. VALIDATION DU MODAL DE DATE PERSONNALISÉE
    // =========================================================================
    if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_set_date:')) {
      const guildId = interaction.guildId;
      const campaignId = interaction.customId.split(':')[1];
      const rawDate = interaction.fields.getTextInputValue('date_input');
      const rawTime = interaction.fields.getTextInputValue('time_input');

      const parsedISO = parseUserDateFR(rawDate);
      if (!parsedISO) {
        await interaction.reply({
          content: 'Format de date invalide. Utilise le format JJ/MM/AAAA (ex: 30/10/2026).',
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      const normTime = parseTimeInput(rawTime).label;
      await interaction.deferUpdate();

      const updated = setManualSessionDate(guildId, campaignId, parsedISO, normTime);
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
