const DAYS_SHORT = ['LUN', 'MAR', 'MER', 'JEU', 'VEN', 'SAM', 'DIM'];
const DAYS_FULL = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const MONTHS_FULL = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'
];
const MONTHS_SHORT = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

/**
 * Retourne le lundi (à 00:00:00) de la semaine courante ou décalée de `weekOffset` semaines.
 * Utilise l'heure de Paris par défaut.
 */
function getMondayISO(baseDate = null, weekOffset = 0) {
  let d;
  if (!baseDate) {
    d = parseISODate(getTodayISO());
  } else if (typeof baseDate === 'string') {
    d = parseISODate(baseDate);
  } else {
    d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  }
  const day = d.getDay(); // 0 = Dimanche, 1 = Lundi, ...
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday + weekOffset * 7);
  return formatISODate(d);
}

/**
 * Retourne la date courante (heure de Paris) au format ISO "YYYY-MM-DD".
 */
function getTodayISO() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

/**
 * Ajoute un nombre de jours à une date ISO "YYYY-MM-DD"
 */
function addDaysISO(dateISO, daysToAdd = 7) {
  const d = parseISODate(dateISO);
  d.setDate(d.getDate() + daysToAdd);
  return formatISODate(d);
}

/**
 * Retourne le même jour de la semaine suivante par rapport à une date ISO "YYYY-MM-DD"
 */
function addWeeksISO(mondayISO, weeksToAdd = 1) {
  return addDaysISO(mondayISO, weeksToAdd * 7);
}

function formatISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseISODate(isoStr) {
  const [y, m, d] = isoStr.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Génère une liste de N jours consécutifs (par défaut 14 jours : 2 semaines du Lundi au Dimanche) à partir d'une date ISO ("YYYY-MM-DD")
 */
function getRollingDays(startDateISO, dayCount = 14) {
  const baseDate = parseISODate(startDateISO);
  const result = [];
  for (let idx = 0; idx < dayCount; idx++) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + idx);
    const dayNum = String(d.getDate()).padStart(2, '0');
    const monthIdx = d.getMonth();
    const iso = formatISODate(d);
    const jsDay = d.getDay(); // 0 = Dimanche, 1 = Lundi, ...
    const dayOfWeekIdx = jsDay === 0 ? 6 : jsDay - 1;
    const code = DAYS_SHORT[dayOfWeekIdx];
    const fullDayName = DAYS_FULL[dayOfWeekIdx];

    result.push({
      index: idx,
      iso,
      code,
      dayNum,
      monthFull: MONTHS_FULL[monthIdx],
      monthShort: MONTHS_SHORT[monthIdx],
      shortLabel: `${code} ${dayNum}`,
      fullLabel: `${fullDayName} ${dayNum} ${MONTHS_FULL[monthIdx]}`
    });
  }
  return result;
}

/**
 * Génère les 14 jours à partir d'un lundi de départ ISO ("YYYY-MM-DD")
 * (Conserve la signature pour rétro-compatibilité)
 */
function getWeekDaysFromMonday(mondayISO) {
  return getRollingDays(mondayISO, 14);
}

/**
 * Formate une date ISO ("YYYY-MM-DD") en "Vendredi 30 Octobre"
 */
function formatFullDateFR(isoStr) {
  const d = parseISODate(isoStr);
  const jsDay = d.getDay();
  const idx = jsDay === 0 ? 6 : jsDay - 1;
  const dayNum = String(d.getDate()).padStart(2, '0');
  return `${DAYS_FULL[idx]} ${dayNum} ${MONTHS_FULL[d.getMonth()]}`;
}

/**
 * Formate une date ISO ("YYYY-MM-DD") en "08 Novembre" (pour "Joueurs non disponibles jusqu'au XX.")
 */
function formatDayMonthFR(isoStr) {
  const d = parseISODate(isoStr);
  const dayNum = String(d.getDate()).padStart(2, '0');
  return `${dayNum} ${MONTHS_FULL[d.getMonth()]}`;
}

/**
 * Normalise une heure saisie ("21h", "21:00", "20h30") en { label: "21h00", hours: 21, minutes: 0 }
 * Conserve le texte informatif si le format est libre (ex: "vers 20h45").
 */
function parseTimeInput(raw) {
  if (!raw) return { label: null, hours: 21, minutes: 0 };
  const cleaned = String(raw).trim().toLowerCase().replace(':', 'h');
  const match = cleaned.match(/^(\d{1,2})(?:h(\d{0,2}))?$/);
  if (!match) {
    return { label: String(raw).trim(), hours: 21, minutes: 0 };
  }
  const hours = Math.min(23, Math.max(0, parseInt(match[1], 10)));
  const minutes = match[2] ? Math.min(59, Math.max(0, parseInt(match[2], 10))) : 0;
  const label = `${String(hours).padStart(2, '0')}h${String(minutes).padStart(2, '0')}`;
  return { label, hours, minutes };
}

/**
 * Calcule le timestamp (ms) de fin de session (ex: 3 heures après l'heure de début prévue)
 * pour déclencher automatiquement le sondage suivant une fois la session passée.
 */
function getSessionEndTimestamp(dateISO, timeStr = '21h00') {
  const d = parseISODate(dateISO);
  const { hours, minutes } = parseTimeInput(timeStr);
  d.setHours(hours, minutes, 0, 0);
  // On considère la session terminée 3h après son début (ou fin de soirée)
  return d.getTime() + 3 * 60 * 60 * 1000;
}

/**
 * Parse une date saisie par le MJ au format "JJ/MM/AAAA" ou "JJ/MM" ou "YYYY-MM-DD"
 */
function parseUserDateFR(input) {
  const str = String(input).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return str;
  }
  const m = str.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  let year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  return formatISODate(d);
}

/**
 * Décalage (en minutes) entre l'heure de Paris et UTC à un instant donné (gère l'heure d'été/hiver).
 */
function getParisOffsetMinutes(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Paris',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(utcMs));
  const get = type => parseInt(parts.find(p => p.type === type).value, 10);
  const asUTC = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return (asUTC - Math.floor(utcMs / 1000) * 1000) / 60000;
}

/**
 * Convertit une date ISO + heure "murale" de Paris en objet Date (instant absolu),
 * indépendamment du fuseau horaire du serveur d'hébergement (Render tourne en UTC).
 */
function parisWallTimeToDate(dateISO, hours = 21, minutes = 0) {
  const [y, m, d] = dateISO.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, hours, minutes, 0);
  const firstOffset = getParisOffsetMinutes(naive);
  let ts = naive - firstOffset * 60000;
  const secondOffset = getParisOffsetMinutes(ts);
  if (secondOffset !== firstOffset) {
    ts = naive - secondOffset * 60000;
  }
  return new Date(ts);
}

module.exports = {
  parisWallTimeToDate,
  DAYS_SHORT,
  DAYS_FULL,
  MONTHS_FULL,
  MONTHS_SHORT,
  getMondayISO,
  getTodayISO,
  addDaysISO,
  addWeeksISO,
  formatISODate,
  parseISODate,
  getRollingDays,
  getWeekDaysFromMonday,
  formatFullDateFR,
  formatDayMonthFR,
  parseTimeInput,
  getSessionEndTimestamp,
  parseUserDateFR
};
