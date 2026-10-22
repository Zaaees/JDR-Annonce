const DAYS_SHORT = ['LUN', 'MAR', 'MER', 'JEU', 'VEN', 'SAM', 'DIM'];
const DAYS_FULL = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const MONTHS_FULL = [
  'Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin',
  'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'
];
const MONTHS_SHORT = ['Jan', 'Fév', 'Mar', 'Avr', 'Mai', 'Juin', 'Juil', 'Août', 'Sep', 'Oct', 'Nov', 'Déc'];

/**
 * Retourne le lundi (à 00:00:00) de la semaine courante ou décalée de `weekOffset` semaines.
 * Si aujourd'hui est dimanche, le "lundi de la semaine à venir" commence le lendemain si on démarre un sondage en fin de semaine,
 * ou le lundi de la semaine en cours.
 */
function getMondayISO(baseDate = new Date(), weekOffset = 0) {
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
  const day = d.getDay(); // 0 = Dimanche, 1 = Lundi, ...
  const diffToMonday = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diffToMonday + weekOffset * 7);
  return formatISODate(d);
}

/**
 * Retourne le lundi de la semaine suivante par rapport à une date ISO "YYYY-MM-DD"
 */
function addWeeksISO(mondayISO, weeksToAdd = 1) {
  const d = parseISODate(mondayISO);
  d.setDate(d.getDate() + weeksToAdd * 7);
  return formatISODate(d);
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
 * Génère les 7 jours (Lundi -> Dimanche) à partir d'un lundi ISO ("YYYY-MM-DD")
 */
function getWeekDaysFromMonday(mondayISO) {
  const baseMonday = parseISODate(mondayISO);
  return DAYS_SHORT.map((code, idx) => {
    const d = new Date(baseMonday);
    d.setDate(baseMonday.getDate() + idx);
    const dayNum = String(d.getDate()).padStart(2, '0');
    const monthIdx = d.getMonth();
    const iso = formatISODate(d);
    return {
      index: idx,
      iso,
      code,
      dayNum,
      monthFull: MONTHS_FULL[monthIdx],
      monthShort: MONTHS_SHORT[monthIdx],
      shortLabel: `${code} ${dayNum}`,
      fullLabel: `${DAYS_FULL[idx]} ${dayNum} ${MONTHS_FULL[monthIdx]}`
    };
  });
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

module.exports = {
  DAYS_SHORT,
  DAYS_FULL,
  MONTHS_FULL,
  MONTHS_SHORT,
  getMondayISO,
  addWeeksISO,
  formatISODate,
  parseISODate,
  getWeekDaysFromMonday,
  formatFullDateFR,
  formatDayMonthFR,
  parseTimeInput,
  getSessionEndTimestamp,
  parseUserDateFR
};
