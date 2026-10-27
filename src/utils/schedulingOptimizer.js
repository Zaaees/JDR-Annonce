const {
  getRollingDays,
  getMondayISO,
  getTodayISO,
  parseISODate
} = require('./dates');

/**
 * Retourne l'ensemble des participants connus d'une table (joueurs du @Rôle + MJ).
 */
function getCampaignParticipants(campaign) {
  const ids = new Set();
  if (campaign && Array.isArray(campaign.memberIds)) {
    campaign.memberIds.forEach(id => ids.add(id));
  }
  if (campaign && campaign.mjId) ids.add(campaign.mjId);
  return ids;
}

/**
 * Indique si deux tables entrent en conflit de planning, c'est-à-dire si elles partagent
 * au moins un participant (joueur ou MJ). Deux tables sans aucun participant commun
 * peuvent jouer le même jour.
 * Par prudence, si la composition d'une des deux tables est encore inconnue
 * (aucun membre connu), on considère qu'il y a conflit (ancien comportement).
 */
function campaignsConflict(a, b) {
  if (!a || !b) return false;
  const hasKnownMembers = c => Array.isArray(c.memberIds) && c.memberIds.length > 0;
  if (!hasKnownMembers(a) || !hasKnownMembers(b)) return true;

  const participantsA = getCampaignParticipants(a);
  for (const id of getCampaignParticipants(b)) {
    if (participantsA.has(id)) return true;
  }
  return false;
}

/**
 * Récupère la liste des 14 jours d'une campagne avec labels et ISO.
 */
function getCampaignDays(campaign) {
  const startDateISO = campaign.startDateISO || campaign.weekMondayISO || getMondayISO();
  return getRollingDays(startDateISO, 14);
}

/**
 * Calcule les dates ISO où 100% des joueurs attendus sont disponibles pour cette campagne.
 * Ne retourne de dates que si TOUS les membres du rôle ont soumis leur vote.
 *
 * @param {Object} campaign - La campagne à évaluer
 * @param {string[]} roleMemberIds - Identifiants des joueurs membres du @Rôle Discord
 * @returns {string[]} Liste des dates ISO (YYYY-MM-DD) unanimes
 */
function getCampaignUnanimousDates(campaign, roleMemberIds = []) {
  if (!campaign || !campaign.votes) return [];

  const activeVoterIds = roleMemberIds && roleMemberIds.length > 0
    ? roleMemberIds
    : Object.keys(campaign.votes);

  if (activeVoterIds.length === 0) return [];

  // Vérifie si 100% des joueurs attendus ont voté
  const allVoted = activeVoterIds.every(id => Array.isArray(campaign.votes[id]));
  if (!allVoted) return [];

  const todayISO = getTodayISO();
  const days = getCampaignDays(campaign);
  const unanimous = [];

  for (let idx = 0; idx < 14; idx++) {
    if (days[idx] && days[idx].iso <= todayISO) continue;

    const isUnanimous = activeVoterIds.every(id =>
      Array.isArray(campaign.votes[id]) && campaign.votes[id].includes(idx)
    );
    if (isUnanimous && days[idx]) {
      unanimous.push(days[idx].iso);
    }
  }

  return unanimous;
}

/**
 * Calcule les dates ISO où tous les joueurs QUI ONT DÉJÀ VOTÉ sont disponibles.
 * Permet d'anticiper les jours possibles d'un sondage encore en cours (lookahead).
 *
 * @param {Object} campaign - La campagne en cours de vote
 * @returns {string[]} Liste des dates ISO potentielles
 */
function getCampaignPotentialDates(campaign) {
  const days = getCampaignDays(campaign);
  const todayISO = getTodayISO();
  if (!campaign || !campaign.votes) return days.filter(d => d.iso > todayISO).map(d => d.iso);

  const voters = Object.keys(campaign.votes).filter(id => Array.isArray(campaign.votes[id]));
  if (voters.length === 0) {
    return days.filter(d => d.iso > todayISO).map(d => d.iso);
  }

  const potential = [];
  for (let idx = 0; idx < 14; idx++) {
    if (days[idx] && days[idx].iso <= todayISO) continue;
    const worksForAllVoters = voters.every(id => campaign.votes[id].includes(idx));
    if (worksForAllVoters && days[idx]) {
      potential.push(days[idx].iso);
    }
  }

  return potential;
}

/**
 * Calcule le score de contestation (contention) pour une date donnée.
 * Plus le score est élevé, plus cette date est critique pour d'autres tables en cours de sondage.
 *
 * Heuristique MRV (Minimum Remaining Values) :
 * - Si une autre table n'a qu'un seul jour potentiel et que c'est celui-ci -> Score massif (+1000)
 * - Si une autre table a 2 jours potentiels -> Score élevé (+100)
 * - Si elle a 3 jours -> (+40)
 * - Si elle a 4+ jours -> (+5)
 * - Si ce jour n'est pas dans ses votes -> (+0)
 */
function calculateContentionScore(candIso, targetCampaign, allCampaigns) {
  let score = 0;

  for (const other of allCampaigns) {
    if (!other || other.id === targetCampaign.id) continue;
    if (other.status !== 'poll') continue;
    // Une table sans participant commun ne peut pas gêner la table ciblée
    if (!campaignsConflict(other, targetCampaign)) continue;

    const otherPotential = getCampaignPotentialDates(other);
    if (otherPotential.includes(candIso)) {
      const flex = otherPotential.length;
      if (flex <= 1) {
        score += 1000;
      } else if (flex === 2) {
        score += 100;
      } else if (flex === 3) {
        score += 40;
      } else if (flex <= 5) {
        score += 15;
      } else {
        score += 5;
      }
    }
  }

  return score;
}

/**
 * Recherche une alternative 100% unanime pour une campagne déjà confirmée.
 * Permet de lui attribuer un autre créneau si une nouvelle table a un besoin critique de son créneau actuel.
 *
 * @param {Object} confirmedCampaign - La campagne actuellement confirmée
 * @param {Array} allCampaigns - Toutes les campagnes du serveur
 * @param {string[]} excludeDateISOs - Dates interdites (ex: le créneau contesté)
 * @returns {string|null} Nouvelle date ISO valide ou null
 */
function findAlternativeDateForConfirmedCampaign(
  confirmedCampaign,
  allCampaigns,
  excludeDateISOs = []
) {
  if (!confirmedCampaign || !confirmedCampaign.votes || Object.keys(confirmedCampaign.votes).length === 0) {
    return null;
  }

  const unanimousDates = getCampaignUnanimousDates(confirmedCampaign);
  if (unanimousDates.length <= 1) {
    return null;
  }

  const excludeSet = new Set(excludeDateISOs);

  // Exclut les dates réservées par d'autres campagnes confirmées partageant des participants
  for (const c of allCampaigns) {
    if (
      c.id !== confirmedCampaign.id &&
      c.status === 'confirmed' &&
      c.confirmedDateISO &&
      campaignsConflict(c, confirmedCampaign)
    ) {
      excludeSet.add(c.confirmedDateISO);
    }
  }

  const validAlternatives = unanimousDates.filter(iso =>
    iso !== confirmedCampaign.confirmedDateISO && !excludeSet.has(iso)
  );

  if (validAlternatives.length === 0) {
    return null;
  }

  // Trie les alternatives par friction minimale avec les autres sondages, puis par ordre chronologique
  validAlternatives.sort((a, b) => {
    const scoreA = calculateContentionScore(a, confirmedCampaign, allCampaigns);
    const scoreB = calculateContentionScore(b, confirmedCampaign, allCampaigns);
    if (scoreA !== scoreB) return scoreA - scoreB;
    return parseISODate(a) - parseISODate(b);
  });

  return validAlternatives[0];
}

/**
 * Résout l'affectation optimale d'une date pour une campagne dont le vote vient d'être mis à jour.
 *
 * @param {Array} allCampaigns - Liste de toutes les campagnes du serveur
 * @param {string} targetCampaignId - ID de la campagne ciblée
 * @param {string[]} roleMemberIds - Liste des membres attendus pour le vote
 *
 * @returns {Object} Résultat :
 *  - { action: 'WAITING_VOTES' }
 *  - { action: 'NO_COMMON_DAYS' }
 *  - { action: 'CONFIRM', confirmedDateISO }
 *  - { action: 'CONFIRM_WITH_SWAP', confirmedDateISO, swappedCampaign, swappedOldDateISO, swappedNewDateISO }
 *  - { action: 'CONFLICT_BLOCKED', conflictingCampaignNames }
 */
function resolveCampaignSchedule(allCampaigns, targetCampaignId, roleMemberIds = []) {
  const target = allCampaigns.find(c => c.id === targetCampaignId);
  if (!target || target.status !== 'poll') {
    return { action: 'INVALID_STATE' };
  }

  const activeVoterIds = roleMemberIds && roleMemberIds.length > 0
    ? roleMemberIds
    : Object.keys(target.votes || {});

  if (activeVoterIds.length === 0) {
    return { action: 'WAITING_VOTES' };
  }

  const allVoted = activeVoterIds.every(id => Array.isArray(target.votes && target.votes[id]));
  if (!allVoted) {
    return { action: 'WAITING_VOTES' };
  }

  const unanimousDates = getCampaignUnanimousDates(target, roleMemberIds);
  if (unanimousDates.length === 0) {
    return { action: 'NO_COMMON_DAYS' };
  }

  // Dictionnaire des dates déjà occupées par des campagnes confirmées EN CONFLIT avec la cible
  // (même joueur ou même MJ). Les tables sans participant commun ne bloquent pas la date.
  // occupiedMap : date ISO -> liste des campagnes en conflit confirmées ce jour-là
  const occupiedMap = new Map();
  for (const c of allCampaigns) {
    if (
      c.id !== target.id &&
      c.status === 'confirmed' &&
      c.confirmedDateISO &&
      campaignsConflict(c, target)
    ) {
      if (!occupiedMap.has(c.confirmedDateISO)) occupiedMap.set(c.confirmedDateISO, []);
      occupiedMap.get(c.confirmedDateISO).push(c);
    }
  }

  // 1. Recherche directe parmi les dates libres (sans conflit immédiat)
  const availableDates = unanimousDates.filter(iso => !occupiedMap.has(iso));

  if (availableDates.length > 0) {
    // Choix préventif (Lookahead) : privilégier le jour avec le score de contention le plus bas
    availableDates.sort((a, b) => {
      const scoreA = calculateContentionScore(a, target, allCampaigns);
      const scoreB = calculateContentionScore(b, target, allCampaigns);
      if (scoreA !== scoreB) return scoreA - scoreB;
      return parseISODate(a) - parseISODate(b);
    });

    return {
      action: 'CONFIRM',
      confirmedDateISO: availableDates[0]
    };
  }

  // 2. Toutes les dates unanimes de cette table sont occupées.
  // Tentative de permutation intelligente (Smart Swap) avec une table occupante pouvant bouger.
  for (const clashIso of unanimousDates) {
    const occupants = occupiedMap.get(clashIso);
    // Une permutation n'a de sens que si une seule table occupe le créneau
    if (!occupants || occupants.length !== 1) continue;
    const conflictingCampaign = occupants[0];

    const altDateIso = findAlternativeDateForConfirmedCampaign(
      conflictingCampaign,
      allCampaigns,
      [clashIso]
    );

    if (altDateIso) {
      return {
        action: 'CONFIRM_WITH_SWAP',
        confirmedDateISO: clashIso,
        swappedCampaign: conflictingCampaign,
        swappedOldDateISO: clashIso,
        swappedNewDateISO: altDateIso
      };
    }
  }

  // 3. Aucun jour libre et aucune permutation possible : vrai conflit bloquant
  const conflictingNames = [...new Set(
    unanimousDates
      .flatMap(iso => (occupiedMap.get(iso) || []).map(c => c.title))
      .filter(Boolean)
  )];

  return {
    action: 'CONFLICT_BLOCKED',
    conflictingCampaignNames: conflictingNames
  };
}

module.exports = {
  getCampaignParticipants,
  campaignsConflict,
  getCampaignDays,
  getCampaignUnanimousDates,
  getCampaignPotentialDates,
  calculateContentionScore,
  findAlternativeDateForConfirmedCampaign,
  resolveCampaignSchedule
};
