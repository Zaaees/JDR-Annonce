/**
 * Plages horaires des joueurs ("Disponible dès… / Jusqu'à…") et calcul du créneau commun de session.
 *
 * Les heures sont exprimées en minutes depuis minuit du jour de la session.
 * Les heures après minuit sont comptées au-delà de 24h (ex: 01h00 = 25 * 60) pour rester dans la même soirée.
 */

const SESSION_MINUTES = 3 * 60; // Durée d'une session de JDR
const HOURS_STEP = 30;
const HOURS_MIN = 14 * 60; // 14h00
const HOURS_MAX = 25 * 60; // 01h00 (lendemain)
const FULL_RANGE = Object.freeze({ from: HOURS_MIN, to: HOURS_MAX });

/** "19h30" -> 1170. Les heures avant 06h sont considérées après minuit (ex: "00h30" -> 1470). */
function timeLabelToMinutes(label) {
  const m = String(label || '').trim().match(/^(\d{1,2})h(\d{2})$/);
  if (!m) return null;
  let hours = parseInt(m[1], 10);
  const minutes = parseInt(m[2], 10);
  if (hours > 23 || minutes > 59) return null;
  if (hours < 6) hours += 24;
  return hours * 60 + minutes;
}

/** 1170 -> "19h30", 1500 -> "01h00" */
function minutesToTimeLabel(total) {
  const h = Math.floor(total / 60) % 24;
  const m = total % 60;
  return `${String(h).padStart(2, '0')}h${String(m).padStart(2, '0')}`;
}

/** Valeurs possibles pour "Disponible dès…" (14h00 → 22h00) */
function getFromOptions() {
  const out = [];
  for (let t = HOURS_MIN; t <= HOURS_MAX - SESSION_MINUTES; t += HOURS_STEP) out.push(t);
  return out;
}

/** Valeurs possibles pour "Jusqu'à…" (17h00 → 01h00) */
function getToOptions() {
  const out = [];
  for (let t = HOURS_MIN + SESSION_MINUTES; t <= HOURS_MAX; t += HOURS_STEP) out.push(t);
  return out;
}

/** Une plage est valide si elle tient dans 14h-01h et permet au moins une session de 3h. */
function isValidHoursRange(range) {
  if (!range || !Number.isInteger(range.from) || !Number.isInteger(range.to)) return false;
  if (range.from < HOURS_MIN || range.to > HOURS_MAX) return false;
  return range.to - range.from >= SESSION_MINUTES;
}

/**
 * Plage d'un joueur pour un jour donné.
 * `entry` est soit { [dayIdx]: {from,to} } (plage par jour), soit {from,to} (ancienne plage unique = tous les jours).
 * @returns {{from:number,to:number}|null}
 */
function getPlayerHoursForDay(entry, dayIdx) {
  if (!entry) return null;
  if (isValidHoursRange(entry)) return entry;
  const r = entry[dayIdx];
  return isValidHoursRange(r) ? r : null;
}

/**
 * Intersection des plages des joueurs attendus pour un jour. Un joueur sans plage enregistrée
 * (vote antérieur à la fonctionnalité) est considéré disponible sur toute la plage.
 * @returns {{from:number,to:number}|null} null si moins de 3h communes
 */
function getCommonHours(voteHours, voterIds, dayIdx = null) {
  let from = FULL_RANGE.from;
  let to = FULL_RANGE.to;
  for (const id of voterIds || []) {
    const r = getPlayerHoursForDay(voteHours && voteHours[id], dayIdx);
    if (!r) continue;
    from = Math.max(from, r.from);
    to = Math.min(to, r.to);
  }
  if (to - from < SESSION_MINUTES) return null;
  return { from, to };
}

/**
 * Heure de début de session dans le créneau commun : l'heure habituelle du MJ si elle tient,
 * sinon l'heure la plus proche qui laisse 3h de jeu (ou le début commun sans heure MJ).
 */
function pickSessionStart(common, preferredTime) {
  const latestStart = common.to - SESSION_MINUTES;
  const preferred = timeLabelToMinutes(preferredTime);
  if (preferred === null) return minutesToTimeLabel(common.from);
  return minutesToTimeLabel(Math.min(latestStart, Math.max(common.from, preferred)));
}

module.exports = {
  SESSION_MINUTES,
  HOURS_MIN,
  HOURS_MAX,
  timeLabelToMinutes,
  minutesToTimeLabel,
  getFromOptions,
  getToOptions,
  isValidHoursRange,
  getPlayerHoursForDay,
  getCommonHours,
  pickSessionStart
};
