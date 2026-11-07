const fs = require('fs');
const path = require('path');
const {
  getMondayISO,
  getTodayISO,
  addDaysISO,
  addWeeksISO,
  getRollingDays,
  getWeekDaysFromMonday,
  parseTimeInput,
  getSessionEndTimestamp,
  parseISODate
} = require('../utils/dates');
const { resolveCampaignSchedule, campaignsConflict } = require('../utils/schedulingOptimizer');
const { isValidHoursRange, getCommonHours, pickSessionStart } = require('../utils/sessionHours');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const DEFAULT_STATE = {
  guilds: {}
  // guilds[guildId] = {
  //   channelId: null,
  //   dashboardMessageId: null,
  //   campaigns: []
  // }
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(DEFAULT_STATE, null, 2), 'utf8');
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Erreur lecture state.json:', err);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function saveState(state) {
  ensureDataDir();
  const tmpFile = STATE_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmpFile, STATE_FILE);
}

function getGuildState(guildId) {
  const state = loadState();
  if (!state.guilds[guildId]) {
    state.guilds[guildId] = {
      channelId: null,
      dashboardMessageId: null,
      campaigns: []
    };
    saveState(state);
  }
  return { state, guild: state.guilds[guildId] };
}

function setGuildChannel(guildId, channelId, dashboardMessageId = null) {
  const { state, guild } = getGuildState(guildId);
  guild.channelId = channelId;
  if (dashboardMessageId !== undefined) {
    guild.dashboardMessageId = dashboardMessageId;
  }
  saveState(state);
  return guild;
}

function restoreGuildState(guildId, restoredGuildData) {
  if (!restoredGuildData || !Array.isArray(restoredGuildData.campaigns)) return null;
  const state = loadState();
  state.guilds[guildId] = {
    channelId: restoredGuildData.channelId || null,
    dashboardMessageId: restoredGuildData.dashboardMessageId || null,
    campaigns: restoredGuildData.campaigns,
    playerHours: restoredGuildData.playerHours || {}
  };
  saveState(state);
  return state.guilds[guildId];
}

function setDashboardMessageId(guildId, messageId) {
  const { state, guild } = getGuildState(guildId);
  guild.dashboardMessageId = messageId;
  saveState(state);
}

function setCampaignPingMessageId(guildId, campaignId, pingMessageId) {
  const { state, guild } = getGuildState(guildId);
  const c = guild.campaigns.find(x => x.id === campaignId);
  if (c) {
    c.lastPingMessageId = pingMessageId;
    saveState(state);
  }
}

/**
 * Met à jour la liste des joueurs connus d'une table (n'écrit sur disque que si elle a changé).
 */
function updateCampaignMembers(guildId, campaignId, memberIds) {
  if (!Array.isArray(memberIds)) return;
  const { state, guild } = getGuildState(guildId);
  const c = guild.campaigns.find(x => x.id === campaignId);
  if (!c) return;
  const next = [...new Set(memberIds)].sort();
  const prev = Array.isArray(c.memberIds) ? [...c.memberIds].sort() : [];
  if (next.length === prev.length && next.every((id, i) => id === prev[i])) return;
  c.memberIds = next;
  saveState(state);
}

/**
 * Mémorise la dernière relance des retardataires (message + horodatage).
 */
function setCampaignNudge(guildId, campaignId, messageId, at = Date.now()) {
  const { state, guild } = getGuildState(guildId);
  const c = guild.campaigns.find(x => x.id === campaignId);
  if (!c) return;
  c.lastNudgeMessageId = messageId || null;
  c.lastNudgeAt = messageId ? at : null;
  saveState(state);
}

/**
 * Mémorise l'identifiant de l'événement Discord natif lié à la session confirmée.
 */
function setCampaignEventId(guildId, campaignId, eventId) {
  const { state, guild } = getGuildState(guildId);
  const c = guild.campaigns.find(x => x.id === campaignId);
  if (!c) return;
  c.scheduledEventId = eventId || null;
  saveState(state);
}

/**
 * Oublie la relance en cours (nouveau sondage = nouveau cycle de relance).
 */
function resetNudge(campaign) {
  campaign.lastNudgeMessageId = null;
  campaign.lastNudgeAt = null;
}

function createCampaign(guildId, {
  title,
  mjId,
  mjName,
  roleId,
  roleName,
  roleColor = '#f59e0b',
  theme = 'fantasy',
  time = null,
  bannerUrl = null,
  bannerMessageId = null,
  bannerChannelId = null
}) {
  const { state, guild } = getGuildState(guildId);
  const normTime = time ? parseTimeInput(time).label : null;
  const startDateISO = getMondayISO();

  const campaign = {
    id: `jdr_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    title: String(title).trim().toUpperCase(),
    mjId,
    mjName,
    roleId,
    roleName,
    roleColor: roleColor || '#f59e0b',
    theme,
    time: normTime,
    bannerUrl: bannerUrl || null,
    bannerMessageId: bannerMessageId || null,
    bannerChannelId: bannerChannelId || null,
    startDateISO,
    weekMondayISO: startDateISO, // Conservé pour rétro-compatibilité
    failedWeeksCount: 0,
    unavailableUntilISO: null,
    status: 'poll', // 'poll' | 'confirmed' | 'unavailable'
    confirmedDateISO: null,
    votes: {}, // { [userId]: [0, 3, 5] } (indices 0..13 pour les 14 jours)
    voteHours: {}, // { [userId]: { from, to } } plage horaire en minutes (cf. utils/sessionHours)
    memberIds: [], // Joueurs connus du @Rôle (sert aux conflits de planning par participant)
    lastPingMessageId: null,
    lastNudgeMessageId: null, // Dernière relance des retardataires
    lastNudgeAt: null,
    scheduledEventId: null // Événement Discord natif lié à la session confirmée
  };

  guild.campaigns.push(campaign);
  saveState(state);
  return campaign;
}

function deleteCampaign(guildId, campaignId) {
  const { state, guild } = getGuildState(guildId);
  const idx = guild.campaigns.findIndex(x => x.id === campaignId);
  if (idx === -1) return null;
  const [removed] = guild.campaigns.splice(idx, 1);
  saveState(state);
  return removed;
}

function updateCampaignConfig(guildId, campaignId, updates) {
  const { state, guild } = getGuildState(guildId);
  const c = guild.campaigns.find(x => x.id === campaignId);
  if (!c) return null;
  if (updates.title) c.title = String(updates.title).trim().toUpperCase();
  if (updates.time !== undefined) {
    c.time = updates.time ? parseTimeInput(updates.time).label : null;
    delete c.preferredTime; // Choix explicite du MJ : devient l'heure habituelle
  }
  if (updates.theme) c.theme = updates.theme;
  if (updates.bannerUrl !== undefined) c.bannerUrl = updates.bannerUrl;
  if (updates.bannerMessageId !== undefined) c.bannerMessageId = updates.bannerMessageId;
  if (updates.bannerChannelId !== undefined) c.bannerChannelId = updates.bannerChannelId;
  if (updates.mjId) c.mjId = updates.mjId;
  if (updates.mjName) c.mjName = updates.mjName;
  if (updates.roleId) c.roleId = updates.roleId;
  if (updates.roleName) c.roleName = updates.roleName;
  if (updates.roleColor) c.roleColor = updates.roleColor;
  saveState(state);
  return c;
}

/**
 * Gère l'échec d'une période de sondage (soit un joueur a choisi "Indisponible",
 * soit tous les joueurs du rôle ont voté mais aucun jour ne réunit 100%).
 */
function handlePollWeekNoMatch(campaign) {
  const startDateISO = campaign.startDateISO || campaign.weekMondayISO || getMondayISO();
  const currentDays = getRollingDays(startDateISO, 14);
  const lastDayISO = currentDays[13].iso;
  campaign.failedWeeksCount = (campaign.failedWeeksCount || 0) + 1;

  if (campaign.failedWeeksCount >= 2) {
    // 2 périodes consécutives sans disponibilité -> En attente du MJ
    campaign.status = 'unavailable';
    campaign.confirmedDateISO = null;
    campaign.unavailableUntilISO = lastDayISO;
    campaign.votes = {};
    campaign.voteHours = {};
    resetNudge(campaign);
    return {
      event: 'UNAVAILABLE_2_WEEKS',
      campaign
    };
  } else {
    // Passage immédiat aux 2 semaines suivantes (décalage de 14 jours pour recommencer un lundi)
    const nextStartISO = addDaysISO(startDateISO, 14);
    campaign.startDateISO = nextStartISO;
    campaign.weekMondayISO = nextStartISO;
    campaign.status = 'poll';
    campaign.confirmedDateISO = null;
    campaign.unavailableUntilISO = null;
    campaign.votes = {};
    campaign.voteHours = {};
    resetNudge(campaign);
    return {
      event: 'SHIFTED_NEXT_WEEK',
      campaign
    };
  }
}

/**
 * Fixe l'heure d'une session verrouillée automatiquement à partir des plages communes des joueurs.
 * L'heure habituelle du MJ est mise de côté (preferredTime) pour être restaurée à la relance.
 */
function applyCommonSessionTime(campaign, voterIds) {
  // Aucun joueur n'a donné de plage (votes antérieurs à la fonctionnalité) : l'heure du MJ reste telle quelle
  const anyHours = voterIds.some(id => isValidHoursRange(campaign.voteHours && campaign.voteHours[id]));
  if (!anyHours) return;
  const common = getCommonHours(campaign.voteHours, voterIds);
  if (!common) return;
  const habitual = campaign.preferredTime !== undefined ? campaign.preferredTime : campaign.time;
  const start = pickSessionStart(common, habitual);
  if (start === campaign.time) return;
  campaign.preferredTime = habitual || null;
  campaign.time = start;
}

/**
 * Remet l'heure habituelle du MJ si l'heure actuelle a été calculée depuis les plages des joueurs.
 */
function restoreHabitualTime(campaign) {
  if (campaign.preferredTime === undefined) return;
  campaign.time = campaign.preferredTime;
  delete campaign.preferredTime;
}

/**
 * Enregistre le vote d'un joueur appartenant au @Rôle du JDR.
 * @param {string} guildId
 * @param {string} campaignId
 * @param {string} userId
 * @param {string[]} selectedValues - ex: ['0', '3', '5'] ou ['UNAVAILABLE']
 * @param {string[]} roleMemberIds - Liste des userId des membres du @Rôle devant voter
 * @param {{from:number,to:number}|null} hours - Plage horaire du joueur (minutes), ignorée si invalide
 */
function submitPlayerVote(guildId, campaignId, userId, selectedValues, roleMemberIds, hours = null) {
  const { state, guild } = getGuildState(guildId);
  const c = guild.campaigns.find(x => x.id === campaignId);
  if (!c || c.status !== 'poll') {
    return { event: 'INVALID_STATE', campaign: c };
  }

  // Cas 1 : Le joueur a sélectionné "Indisponible" (pas dispo sur la période)
  if (selectedValues.includes('UNAVAILABLE') || selectedValues.includes('NEXT_WEEK')) {
    const result = handlePollWeekNoMatch(c);
    saveState(state);
    return result;
  }

  // Cas 2 : Le joueur a sélectionné un ou plusieurs jours (0..13)
  const todayISO = getTodayISO();
  const currentDays = getRollingDays(c.startDateISO || c.weekMondayISO || getMondayISO(), 14);
  const dayIndices = selectedValues
    .map(v => parseInt(v, 10))
    .filter(n => !Number.isNaN(n) && n >= 0 && n <= 13)
    .filter(n => !currentDays[n] || currentDays[n].iso > todayISO);

  c.votes[userId] = dayIndices;
  if (isValidHoursRange(hours)) {
    const range = { from: hours.from, to: hours.to };
    if (!c.voteHours) c.voteHours = {};
    c.voteHours[userId] = range;
    // Dernière plage du joueur : sert à préremplir ses prochains votes
    if (!guild.playerHours) guild.playerHours = {};
    guild.playerHours[userId] = { ...range };
  }

  // Mémorise la composition connue de la table (sert à détecter les conflits par participant)
  if (Array.isArray(roleMemberIds) && roleMemberIds.length > 0) {
    c.memberIds = [...roleMemberIds];
  }

  // Liste effective des joueurs attendus (tous les membres du @Rôle)
  const activeVoterIds = roleMemberIds.length > 0 ? roleMemberIds : Object.keys(c.votes);

  // Résolution intelligente des créneaux (MRV lookahead + Smart Swap sans collision)
  const resolution = resolveCampaignSchedule(guild.campaigns, c.id, activeVoterIds);

  if (resolution.action === 'CONFIRM') {
    c.status = 'confirmed';
    c.confirmedDateISO = resolution.confirmedDateISO;
    applyCommonSessionTime(c, activeVoterIds);
    c.failedWeeksCount = 0;
    c.unavailableUntilISO = null;
    saveState(state);
    return {
      event: 'AUTO_CONFIRMED',
      campaign: c,
      confirmedDateISO: c.confirmedDateISO
    };
  }

  if (resolution.action === 'CONFIRM_WITH_SWAP') {
    // Met à jour la table déplacée
    const swapped = guild.campaigns.find(x => x.id === resolution.swappedCampaign.id);
    if (swapped) {
      swapped.confirmedDateISO = resolution.swappedNewDateISO;
      swapped.status = 'confirmed';
      swapped.failedWeeksCount = 0;
      swapped.unavailableUntilISO = null;
    }

    // Met à jour la table courante
    c.status = 'confirmed';
    c.confirmedDateISO = resolution.confirmedDateISO;
    applyCommonSessionTime(c, activeVoterIds);
    c.failedWeeksCount = 0;
    c.unavailableUntilISO = null;
    saveState(state);

    return {
      event: 'AUTO_CONFIRMED_WITH_SWAP',
      campaign: c,
      confirmedDateISO: c.confirmedDateISO,
      swappedCampaign: swapped || resolution.swappedCampaign,
      swappedOldDateISO: resolution.swappedOldDateISO,
      swappedNewDateISO: resolution.swappedNewDateISO
    };
  }

  if (resolution.action === 'CONFLICT_BLOCKED') {
    const result = handlePollWeekNoMatch(c);
    saveState(state);
    return {
      ...result,
      conflictReason: 'DATE_ALREADY_TAKEN',
      conflictingCampaignNames: resolution.conflictingCampaignNames
    };
  }

  if (resolution.action === 'NO_COMMON_HOURS') {
    const result = handlePollWeekNoMatch(c);
    saveState(state);
    return { ...result, conflictReason: 'NO_COMMON_HOURS' };
  }

  if (resolution.action === 'NO_COMMON_DAYS') {
    const result = handlePollWeekNoMatch(c);
    saveState(state);
    return result;
  }

  // Cas WAITING_VOTES : tous les joueurs n'ont pas encore voté
  saveState(state);
  return {
    event: 'VOTE_RECORDED',
    campaign: c
  };
}

/**
 * Fixe ou modifie manuellement la date d'une session (par le MJ).
 * Refuse d'écraser un jour déjà confirmé par une autre table JDR.
 */
function setManualSessionDate(guildId, campaignId, dateISO, timeStr = null) {
  const { state, guild } = getGuildState(guildId);
  const c = guild.campaigns.find(x => x.id === campaignId);
  if (!c) return { success: false, error: 'NOT_FOUND' };

  const conflicting = guild.campaigns.find(
    other =>
      other.id !== campaignId &&
      other.status === 'confirmed' &&
      other.confirmedDateISO === dateISO &&
      campaignsConflict(other, c)
  );
  if (conflicting) {
    return {
      success: false,
      error: 'DATE_ALREADY_TAKEN',
      conflictingCampaign: conflicting
    };
  }

  c.status = 'confirmed';
  c.confirmedDateISO = dateISO;
  if (timeStr) {
    c.time = parseTimeInput(timeStr).label;
    delete c.preferredTime;
  }
  c.failedWeeksCount = 0;
  c.unavailableUntilISO = null;
  saveState(state);
  return { success: true, campaign: c };
}

/**
 * Retire la date confirmée et repasse en sondage
 */
function clearSessionDate(guildId, campaignId) {
  const { state, guild } = getGuildState(guildId);
  const c = guild.campaigns.find(x => x.id === campaignId);
  if (!c) return null;

  c.status = 'poll';
  c.confirmedDateISO = null;
  c.failedWeeksCount = 0;
  c.unavailableUntilISO = null;
  restoreHabitualTime(c);
  saveState(state);
  return c;
}

/**
 * Relance un sondage (par le MJ ou après une session terminée)
 * @param {boolean} nextWeek - si true, lance le sondage sur la période suivant la session terminée
 */
function restartCampaignPoll(guildId, campaignId, { nextWeek = false } = {}) {
  const { state, guild } = getGuildState(guildId);
  const c = guild.campaigns.find(x => x.id === campaignId);
  if (!c) return null;

  if (nextWeek) {
    const todayISO = getTodayISO();
    const refDateISO = c.confirmedDateISO || c.startDateISO || c.weekMondayISO || todayISO;
    const refDate = parseISODate(refDateISO);
    const start = getMondayISO(refDate, 1);
    c.startDateISO = start;
    c.weekMondayISO = start;
  } else {
    const start = getMondayISO();
    c.startDateISO = start;
    c.weekMondayISO = start;
  }

  c.status = 'poll';
  c.confirmedDateISO = null;
  c.failedWeeksCount = 0;
  c.unavailableUntilISO = null;
  c.votes = {};
  c.voteHours = {};
  restoreHabitualTime(c);
  resetNudge(c);
  saveState(state);
  return c;
}

/**
 * Modifie le statut de la table ('poll', 'paused', 'prep')
 */
function setCampaignStatus(guildId, campaignId, newStatus) {
  const { state, guild } = getGuildState(guildId);
  const c = guild.campaigns.find(x => x.id === campaignId);
  if (!c) return null;

  c.status = newStatus;
  if (newStatus === 'paused' || newStatus === 'prep') {
    c.confirmedDateISO = null;
    c.time = null;
    delete c.preferredTime;
    c.votes = {};
    c.voteHours = {};
    resetNudge(c);
    c.failedWeeksCount = 0;
    c.unavailableUntilISO = null;
  } else if (newStatus === 'poll') {
    const start = getMondayISO();
    c.startDateISO = start;
    c.weekMondayISO = start;
    c.confirmedDateISO = null;
    c.time = null;
    delete c.preferredTime;
    c.votes = {};
    c.voteHours = {};
    resetNudge(c);
    c.failedWeeksCount = 0;
    c.unavailableUntilISO = null;
  }
  saveState(state);
  return c;
}

/**
 * Le passage automatique est désactivé : c'est le MJ qui clôture la session quand il le souhaite.
 */
function checkAndRollOverFinishedSessions() {
  return [];
}

module.exports = {
  loadState,
  saveState,
  getGuildState,
  setGuildChannel,
  restoreGuildState,
  setDashboardMessageId,
  setCampaignPingMessageId,
  updateCampaignMembers,
  setCampaignNudge,
  setCampaignEventId,
  createCampaign,
  deleteCampaign,
  updateCampaignConfig,
  submitPlayerVote,
  setManualSessionDate,
  clearSessionDate,
  restartCampaignPoll,
  setCampaignStatus,
  checkAndRollOverFinishedSessions
};
