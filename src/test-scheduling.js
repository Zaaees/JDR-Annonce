const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Configure test environment (utilise un state.json temporaire pour les tests)
const testDataDir = path.join(__dirname, '..', 'data');
const testStateFile = path.join(testDataDir, 'state.json');
const backupStateFile = path.join(testDataDir, 'state.json.bak_test');

// Sauvegarde l'état actuel s'il existe
if (fs.existsSync(testStateFile)) {
  fs.copyFileSync(testStateFile, backupStateFile);
}

const {
  loadState,
  saveState,
  getGuildState,
  createCampaign,
  submitPlayerVote,
  setManualSessionDate,
  clearSessionDate,
  deleteCampaign
} = require('./storage/store');
const { getRollingDays, getMondayISO } = require('./utils/dates');

function resetTestState(guildId = 'guild_test') {
  const state = {
    guilds: {
      [guildId]: {
        channelId: 'chan_123',
        dashboardMessageId: null,
        campaigns: []
      }
    }
  };
  saveState(state);
  return state;
}

console.log('🧪 DÉBUT DES TESTS DU SYSTÈME D\'ARBITRAGE DE PLANNING JDR\n');
// Note : les tests 1 à 5 simulent des tables qui partagent le même MJ (mj_1). Depuis les conflits ciblés,
// seules les tables ayant au moins un participant commun (joueur ou MJ) se bloquent mutuellement.
// Les tests 6 et 7 couvrent explicitement les tables indépendantes / partageant un joueur.


try {
  const guildId = 'guild_test';
  const startISO = getMondayISO();
  const rollingDays = getRollingDays(startISO, 14);

  // Jour 4 = Vendredi Semaine 1, Jour 5 = Samedi Semaine 1
  const fridayIso = rollingDays[4].iso;
  const saturdayIso = rollingDays[5].iso;
  const sundayIso = rollingDays[6].iso;

  console.log(`Dates de référence :`);
  console.log(` - Vendredi S1 : ${rollingDays[4].fullLabel} (${fridayIso})`);
  console.log(` - Samedi S1   : ${rollingDays[5].fullLabel} (${saturdayIso})`);
  console.log(` - Dimanche S1 : ${rollingDays[6].fullLabel} (${sundayIso})\n`);

  // =========================================================================
  // TEST 1 : Lookahead préventif (L'exemple exact de l'utilisateur)
  // Table A : 2 jours (Vendredi, Samedi)
  // Table B : 1 jour en cours (Vendredi uniquement par son premier joueur)
  // Table A termine ses votes -> DOIT choisir Samedi pour laisser Vendredi à Table B !
  // =========================================================================
  console.log('--- Test 1 : Choix préventif intelligent (MRV Lookahead) ---');
  resetTestState(guildId);

  const campA = createCampaign(guildId, {
    title: 'DONJONS & DRAGONS',
    mjId: 'mj_1',
    roleId: 'role_a'
  });
  const campB = createCampaign(guildId, {
    title: 'L\'APPEL DE CTHULHU',
    mjId: 'mj_1',
    roleId: 'role_b'
  });

  // Table B a un joueur qui vote UNIQUEMENT Vendredi (indice 4)
  submitPlayerVote(guildId, campB.id, 'player_b1', ['4'], ['player_b1', 'player_b2']);

  // Table A a ses 2 joueurs qui votent Vendredi (4) et Samedi (5)
  submitPlayerVote(guildId, campA.id, 'player_a1', ['4', '5'], ['player_a1', 'player_a2']);
  const resA = submitPlayerVote(guildId, campA.id, 'player_a2', ['4', '5'], ['player_a1', 'player_a2']);

  assert.strictEqual(resA.event, 'AUTO_CONFIRMED');
  assert.strictEqual(
    resA.confirmedDateISO,
    saturdayIso,
    'Table A aurait dû choisir Samedi car Vendredi est fortement contesté par Table B !'
  );
  console.log(`✅ Table A a intelligemment choisi le Samedi (${saturdayIso}) pour préserver le Vendredi de Table B.`);

  // Table B termine ses votes (joueur 2 vote Vendredi)
  const resB = submitPlayerVote(guildId, campB.id, 'player_b2', ['4'], ['player_b1', 'player_b2']);
  assert.strictEqual(resB.event, 'AUTO_CONFIRMED');
  assert.strictEqual(
    resB.confirmedDateISO,
    fridayIso,
    'Table B aurait dû obtenir Vendredi sans conflit !'
  );
  console.log(`✅ Table B a validé son seul jour (Vendredi, ${fridayIso}). Aucun conflit entre A et B !`);

  // =========================================================================
  // TEST 2 : Permutation dynamique (Smart Swap)
  // Table A a validé Vendredi avant que Table B ne vote.
  // Table B termine son vote plus tard et n'a QUE Vendredi.
  // Table A doit permuter sur Samedi et Table B prendre Vendredi.
  // =========================================================================
  console.log('\n--- Test 2 : Permutation dynamique automatique (Smart Swap) ---');
  resetTestState(guildId);

  const swapA = createCampaign(guildId, {
    title: 'WARHAMMER',
    mjId: 'mj_1',
    roleId: 'role_w'
  });
  const swapB = createCampaign(guildId, {
    title: 'CYBERPUNK RED',
    mjId: 'mj_1',
    roleId: 'role_c'
  });

  // Table A vote seule au début : dispo Vendredi (4) et Samedi (5)
  submitPlayerVote(guildId, swapA.id, 'player_w1', ['4', '5'], ['player_w1', 'player_w2']);
  const initResA = submitPlayerVote(guildId, swapA.id, 'player_w2', ['4', '5'], ['player_w1', 'player_w2']);
  assert.strictEqual(initResA.event, 'AUTO_CONFIRMED');
  assert.strictEqual(initResA.confirmedDateISO, fridayIso, 'Table A prend initialement Vendredi (premier jour libre)');
  console.log(`Table A s'était d'abord placée sur Vendredi (${fridayIso}).`);

  // Plus tard, Table B vote et n'a QUE Vendredi (indice 4)
  submitPlayerVote(guildId, swapB.id, 'player_c1', ['4'], ['player_c1', 'player_c2']);
  const resSwapB = submitPlayerVote(guildId, swapB.id, 'player_c2', ['4'], ['player_c1', 'player_c2']);

  assert.strictEqual(resSwapB.event, 'AUTO_CONFIRMED_WITH_SWAP', 'Devrait déclencher une permutation automatique');
  assert.strictEqual(resSwapB.confirmedDateISO, fridayIso, 'Table B doit obtenir Vendredi');
  assert.strictEqual(resSwapB.swappedOldDateISO, fridayIso);
  assert.strictEqual(resSwapB.swappedNewDateISO, saturdayIso, 'Table A doit avoir été basculée sur Samedi');

  // Vérifie l'état persisté dans la base
  const stateCheck = loadState();
  const savedA = stateCheck.guilds[guildId].campaigns.find(c => c.id === swapA.id);
  const savedB = stateCheck.guilds[guildId].campaigns.find(c => c.id === swapB.id);

  assert.strictEqual(savedA.confirmedDateISO, saturdayIso);
  assert.strictEqual(savedB.confirmedDateISO, fridayIso);
  console.log(`✅ Smart Swap réussi : Table A déplacée à Samedi (${saturdayIso}), Table B confirmée sur Vendredi (${fridayIso}).`);

  // =========================================================================
  // TEST 3 : Ordre inverse (B vote avant A)
  // Table B n'a que Vendredi et termine en premier.
  // Table A a Vendredi et Samedi et termine en second.
  // Table A doit automatiquement se placer sur Samedi sans perturber B.
  // =========================================================================
  console.log('\n--- Test 3 : Ordre inverse de vote ---');
  resetTestState(guildId);

  const invA = createCampaign(guildId, { title: 'TABLE SOUPLE', mjId: 'mj_1', roleId: 'role_s' });
  const invB = createCampaign(guildId, { title: 'TABLE CONTRAINTE', mjId: 'mj_1', roleId: 'role_c' });

  // Table B vote et confirme en premier
  submitPlayerVote(guildId, invB.id, 'p_b1', ['4'], ['p_b1', 'p_b2']);
  const resInvB = submitPlayerVote(guildId, invB.id, 'p_b2', ['4'], ['p_b1', 'p_b2']);
  assert.strictEqual(resInvB.confirmedDateISO, fridayIso);

  // Table A vote ensuite
  submitPlayerVote(guildId, invA.id, 'p_a1', ['4', '5'], ['p_a1', 'p_a2']);
  const resInvA = submitPlayerVote(guildId, invA.id, 'p_a2', ['4', '5'], ['p_a1', 'p_a2']);
  assert.strictEqual(resInvA.event, 'AUTO_CONFIRMED');
  assert.strictEqual(resInvA.confirmedDateISO, saturdayIso, 'Table A doit prendre Samedi car Vendredi est occupé');
  console.log(`✅ Ordre inverse validé sans friction.`);

  // =========================================================================
  // TEST 4 : Conflit dur insoluble (Toutes deux UNIQUEMENT Vendredi)
  // Table A confirme Vendredi.
  // Table B arrive avec UNIQUEMENT Vendredi (aucune alternative pour A ni pour B).
  // Table B doit être décalée proprement avec mention du conflit, et Table A préservée.
  // =========================================================================
  console.log('\n--- Test 4 : Conflit dur insoluble sans écrasement ---');
  resetTestState(guildId);

  const hardA = createCampaign(guildId, { title: 'TABLE A UNIQUE', mjId: 'mj_1', roleId: 'role_ha' });
  const hardB = createCampaign(guildId, { title: 'TABLE B UNIQUE', mjId: 'mj_1', roleId: 'role_hb' });

  submitPlayerVote(guildId, hardA.id, 'p_ha', ['4'], ['p_ha']); // Confirme Vendredi

  const resHardB = submitPlayerVote(guildId, hardB.id, 'p_hb', ['4'], ['p_hb']);
  assert.strictEqual(resHardB.event, 'SHIFTED_NEXT_WEEK', 'Table B doit être décalée');
  assert.strictEqual(resHardB.conflictReason, 'DATE_ALREADY_TAKEN');
  assert.ok(resHardB.conflictingCampaignNames.includes('TABLE A UNIQUE'));

  // Table A ne doit pas avoir bougé
  const finalHardA = loadState().guilds[guildId].campaigns.find(c => c.id === hardA.id);
  assert.strictEqual(finalHardA.confirmedDateISO, fridayIso);
  console.log(`✅ Conflit dur géré sans écrasement avec motif clair : ${resHardB.conflictingCampaignNames.join(', ')}.`);

  // =========================================================================
  // TEST 5 : Protection du panneau MJ (setManualSessionDate)
  // Refus d'écraser un jour déjà confirmé par une autre table.
  // =========================================================================
  console.log('\n--- Test 5 : Protection contre le forçage manuel MJ ---');
  resetTestState(guildId);

  const mjCampA = createCampaign(guildId, { title: 'TABLE ALIEN', mjId: 'mj_1', roleId: 'role_al' });
  const mjCampB = createCampaign(guildId, { title: 'TABLE SHADOWRUN', mjId: 'mj_1', roleId: 'role_sr' });

  // Table A est confirmée sur Vendredi
  setManualSessionDate(guildId, mjCampA.id, fridayIso);

  // Le MJ de Table B tente de choisir aussi Vendredi
  const failSet = setManualSessionDate(guildId, mjCampB.id, fridayIso);
  assert.strictEqual(failSet.success, false);
  assert.strictEqual(failSet.error, 'DATE_ALREADY_TAKEN');
  assert.strictEqual(failSet.conflictingCampaign.id, mjCampA.id);
  console.log(`✅ Forçage manuel rejeté pour le jour déjà occupé.`);

  // Le MJ de Table B choisit Dimanche (libre)
  const okSet = setManualSessionDate(guildId, mjCampB.id, sundayIso);
  assert.strictEqual(okSet.success, true);
  assert.strictEqual(okSet.campaign.confirmedDateISO, sundayIso);
  console.log(`✅ Choix manuel accepté pour un jour libre (${sundayIso}).`);

  // =========================================================================
  // TEST 6 : Tables indépendantes (aucun joueur ni MJ en commun) -> même jour autorisé
  // =========================================================================
  console.log('\n--- Test 6 : Tables indépendantes sur le même jour ---');
  resetTestState(guildId);

  const indA = createCampaign(guildId, { title: 'TABLE INDEPENDANTE A', mjId: 'mj_a', roleId: 'role_ia' });
  const indB = createCampaign(guildId, { title: 'TABLE INDEPENDANTE B', mjId: 'mj_b', roleId: 'role_ib' });

  submitPlayerVote(guildId, indA.id, 'ia1', ['4'], ['ia1', 'ia2']);
  const resIndA = submitPlayerVote(guildId, indA.id, 'ia2', ['4'], ['ia1', 'ia2']);
  assert.strictEqual(resIndA.event, 'AUTO_CONFIRMED');
  assert.strictEqual(resIndA.confirmedDateISO, fridayIso);

  submitPlayerVote(guildId, indB.id, 'ib1', ['4'], ['ib1', 'ib2']);
  const resIndB = submitPlayerVote(guildId, indB.id, 'ib2', ['4'], ['ib1', 'ib2']);
  assert.strictEqual(resIndB.event, 'AUTO_CONFIRMED', 'Deux tables sans participant commun doivent pouvoir jouer le même jour');
  assert.strictEqual(resIndB.confirmedDateISO, fridayIso);

  // Le forçage manuel du MJ est lui aussi autorisé entre tables indépendantes
  const indC = createCampaign(guildId, { title: 'TABLE INDEPENDANTE C', mjId: 'mj_c', roleId: 'role_ic' });
  submitPlayerVote(guildId, indC.id, 'ic1', ['0'], ['ic1', 'ic2']); // fixe memberIds de C
  const manualInd = setManualSessionDate(guildId, indC.id, fridayIso);
  assert.strictEqual(manualInd.success, true, 'Le MJ doit pouvoir fixer le même jour qu\'une table indépendante');
  console.log('✅ Tables sans participant commun : même jour autorisé (auto et manuel).');

  // =========================================================================
  // TEST 7 : Joueur partagé entre deux tables -> conflit conservé
  // =========================================================================
  console.log('\n--- Test 7 : Joueur partagé entre deux tables ---');
  resetTestState(guildId);

  const shA = createCampaign(guildId, { title: 'TABLE PARTAGE A', mjId: 'mj_a', roleId: 'role_sa' });
  const shB = createCampaign(guildId, { title: 'TABLE PARTAGE B', mjId: 'mj_b', roleId: 'role_sb' });

  submitPlayerVote(guildId, shA.id, 'shared', ['4'], ['shared', 'sa1']);
  const resShA = submitPlayerVote(guildId, shA.id, 'sa1', ['4'], ['shared', 'sa1']);
  assert.strictEqual(resShA.event, 'AUTO_CONFIRMED');

  submitPlayerVote(guildId, shB.id, 'shared', ['4'], ['shared', 'sb1']);
  const resShB = submitPlayerVote(guildId, shB.id, 'sb1', ['4'], ['shared', 'sb1']);
  assert.strictEqual(resShB.event, 'SHIFTED_NEXT_WEEK', 'Un joueur ne peut pas être dans deux tables le même jour');
  assert.strictEqual(resShB.conflictReason, 'DATE_ALREADY_TAKEN');
  assert.ok(resShB.conflictingCampaignNames.includes('TABLE PARTAGE A'));
  console.log('✅ Un joueur partagé continue de bloquer le créneau.');

  // Le MJ d'une table qui joue dans une autre table crée aussi un conflit
  resetTestState(guildId);
  const mjA = createCampaign(guildId, { title: 'TABLE MJ A', mjId: 'mj_a', roleId: 'role_ma' });
  const mjB = createCampaign(guildId, { title: 'TABLE MJ B', mjId: 'mj_b', roleId: 'role_mb' });
  submitPlayerVote(guildId, mjA.id, 'ma1', ['4'], ['ma1']);
  // Le MJ de la table A (mj_a) est joueur dans la table B
  submitPlayerVote(guildId, mjB.id, 'mj_a', ['4'], ['mj_a']);
  const afterMj = loadState().guilds[guildId].campaigns.find(c => c.id === mjB.id);
  assert.strictEqual(afterMj.status, 'poll', 'Le MJ de A joue dans B : le même jour est impossible');
  console.log('✅ Le MJ d\'une table est bien considéré comme participant des autres tables.');

  // =========================================================================
  // TEST 8 : Conversion heure de Paris -> instant absolu (événements Discord)
  // =========================================================================
  console.log('\n--- Test 8 : Heure de Paris pour les événements Discord ---');
  const { parisWallTimeToDate } = require('./utils/dates');
  assert.strictEqual(parisWallTimeToDate('2026-07-10', 21, 0).toISOString(), '2026-07-10T19:00:00.000Z', 'Été = UTC+2');
  assert.strictEqual(parisWallTimeToDate('2026-01-10', 21, 0).toISOString(), '2026-01-10T20:00:00.000Z', 'Hiver = UTC+1');
  assert.strictEqual(parisWallTimeToDate('2026-03-29', 21, 30).toISOString(), '2026-03-29T19:30:00.000Z', 'Jour du passage à l\'heure d\'été');
  const { buildDesiredEvent } = require('./bot/scheduledEvents');
  assert.strictEqual(buildDesiredEvent({ status: 'poll', confirmedDateISO: null, title: 'X' }), null);
  const ev = buildDesiredEvent({ status: 'confirmed', confirmedDateISO: '2026-07-10', time: '20h30', title: 'MA TABLE', mjName: 'Alice', roleName: '@Joueurs' });
  assert.strictEqual(ev.start.toISOString(), '2026-07-10T18:30:00.000Z');
  assert.ok(ev.end > ev.start && ev.name.includes('MA TABLE'));
  console.log('✅ Conversion Paris -> UTC et construction d\'événement corrects.');

  // =========================================================================
  console.log('\n--- Test 9 : Préservation et flexibilité de l\'horaire configuré ---');
  const evAfternoon = buildDesiredEvent({ status: 'confirmed', confirmedDateISO: '2026-07-11', time: '14h00', title: 'TABLE APREM' });
  assert.strictEqual(evAfternoon.start.toISOString(), '2026-07-11T12:00:00.000Z', '14h00 Paris en été = 12h00 UTC');

  // Test persistance c.time sur restartCampaignPoll et clearSessionDate
  const { restartCampaignPoll, clearSessionDate } = require('./storage/store');
  const testTable = createCampaign('guild_test', { title: 'TABLE TEST TIME', mjId: 'mj1', roleId: 'role1', roleName: '@R', time: '20h30' });
  assert.strictEqual(testTable.time, '20h30');
  const cleared = clearSessionDate('guild_test', testTable.id);
  assert.strictEqual(cleared.time, '20h30', 'L\'heure est conservée après retrait de la date');
  const restarted = restartCampaignPoll('guild_test', testTable.id);
  assert.strictEqual(restarted.time, '20h30', 'L\'heure est conservée après relance du sondage');
  console.log('✅ L\'heure configurée persiste pour les prochaines sessions.');

  // =========================================================================
  // TEST 10 : Plages horaires des joueurs (fenêtres coulissantes de 3h)
  // Utilise des jours de la semaine 2 (indices 9 et 10) : toujours dans le futur.
  // =========================================================================
  console.log('\n--- Test 10 : Plages horaires « Dispo dès / Jusqu\'à » ---');
  const {
    timeLabelToMinutes,
    minutesToTimeLabel,
    isValidHoursRange,
    getCommonHours,
    pickSessionStart
  } = require('./utils/sessionHours');

  // Conversions (01h00 = fin de soirée, comptée après minuit)
  assert.strictEqual(timeLabelToMinutes('19h30'), 19 * 60 + 30);
  assert.strictEqual(minutesToTimeLabel(24 * 60 + 60), '01h00');
  assert.strictEqual(minutesToTimeLabel(24 * 60), '00h00');

  // Validité d'une plage : au moins 3h
  assert.strictEqual(isValidHoursRange({ from: 20 * 60, to: 23 * 60 }), true);
  assert.strictEqual(isValidHoursRange({ from: 21 * 60, to: 23 * 60 }), false, 'Moins de 3h');
  assert.strictEqual(isValidHoursRange(null), false);

  // Intersection des plages
  const hrs = {
    p1: { from: 19 * 60, to: 23 * 60 + 30 },
    p2: { from: 20 * 60, to: 25 * 60 }
  };
  assert.deepStrictEqual(getCommonHours(hrs, ['p1', 'p2']), { from: 20 * 60, to: 23 * 60 + 30 });
  assert.strictEqual(
    getCommonHours({ p1: { from: 18 * 60, to: 21 * 60 }, p2: { from: 21 * 60, to: 24 * 60 } }, ['p1', 'p2']),
    null,
    'Aucun chevauchement de 3h'
  );
  // Vote sans plage (ancien vote) = disponible toute la plage 14h-01h
  assert.deepStrictEqual(getCommonHours({ p1: { from: 20 * 60, to: 23 * 60 } }, ['p1', 'legacy']), { from: 20 * 60, to: 23 * 60 });
  assert.deepStrictEqual(getCommonHours(undefined, ['legacy']), { from: 14 * 60, to: 25 * 60 });

  // Choix de l'heure de début : heure du MJ si elle tient, sinon le début commun
  const common = { from: 20 * 60, to: 23 * 60 + 30 };
  assert.strictEqual(pickSessionStart(common, '20h30'), '20h30');
  assert.strictEqual(pickSessionStart(common, '21h00'), '20h30', '21h + 3h dépasse 23h30 : on recale au plus tard possible');
  assert.strictEqual(pickSessionStart(common, '18h00'), '20h00', 'Trop tôt : début commun');
  assert.strictEqual(pickSessionStart(common, null), '20h00');
  assert.strictEqual(pickSessionStart({ from: 22 * 60, to: 25 * 60 }, '22h00'), '22h00');
  console.log('✅ Calcul des plages communes et de l\'heure de début correct.');

  // Intégration : verrouillage avec heure calculée
  resetTestState(guildId);
  const hrsTable = createCampaign(guildId, { title: 'TABLE HORAIRES', mjId: 'mj_h', roleId: 'role_h', time: '18h00' });
  const hMembers = ['h1', 'h2'];
  const wedW2 = rollingDays[9].iso;
  submitPlayerVote(guildId, hrsTable.id, 'h1', ['9', '10'], hMembers, { from: 19 * 60, to: 23 * 60 + 30 });
  const resHrs = submitPlayerVote(guildId, hrsTable.id, 'h2', ['9'], hMembers, { from: 20 * 60, to: 25 * 60 });
  assert.strictEqual(resHrs.event, 'AUTO_CONFIRMED');
  assert.strictEqual(resHrs.confirmedDateISO, wedW2);
  assert.strictEqual(resHrs.campaign.time, '20h00', 'Heure MJ (18h) hors plage commune : début commun 20h00');
  const savedGuild = loadState().guilds[guildId];
  assert.deepStrictEqual(savedGuild.playerHours.h2, { from: 20 * 60, to: 25 * 60 }, 'Dernière plage mémorisée pour préremplir');
  // Relance : l'heure habituelle du MJ revient
  const restartedHrs = restartCampaignPoll(guildId, hrsTable.id);
  assert.strictEqual(restartedHrs.time, '18h00', 'L\'heure du MJ est restaurée après la session');
  assert.deepStrictEqual(restartedHrs.voteHours, {}, 'Les plages sont remises à zéro');
  console.log('✅ Session verrouillée à l\'heure commune, heure du MJ restaurée ensuite.');

  // Anciens votes sans plage : l'heure (même absente) n'est pas modifiée
  resetTestState(guildId);
  const legacyTable = createCampaign(guildId, { title: 'TABLE ANCIENS VOTES', mjId: 'mj_l', roleId: 'role_l' });
  submitPlayerVote(guildId, legacyTable.id, 'l1', ['9'], ['l1', 'l2']);
  const resLegacy = submitPlayerVote(guildId, legacyTable.id, 'l2', ['9'], ['l1', 'l2']);
  assert.strictEqual(resLegacy.event, 'AUTO_CONFIRMED');
  assert.strictEqual(resLegacy.campaign.time, null, 'Sans plage joueur, le bot ne fixe pas d\'heure arbitraire');
  console.log('✅ Votes sans plage horaire : heure inchangée.');

  // Jour commun mais pas 3h communes -> report avec motif explicite
  resetTestState(guildId);
  const noHrs = createCampaign(guildId, { title: 'TABLE SANS CRENEAU', mjId: 'mj_n', roleId: 'role_n' });
  submitPlayerVote(guildId, noHrs.id, 'n1', ['9'], ['n1', 'n2'], { from: 18 * 60, to: 21 * 60 });
  const resNoHrs = submitPlayerVote(guildId, noHrs.id, 'n2', ['9'], ['n1', 'n2'], { from: 21 * 60, to: 24 * 60 });
  assert.strictEqual(resNoHrs.event, 'SHIFTED_NEXT_WEEK');
  assert.strictEqual(resNoHrs.conflictReason, 'NO_COMMON_HOURS');
  console.log('✅ Pas de créneau de 3h commun : report avec motif « NO_COMMON_HOURS ».');

  // Ni jour commun ni heures communes -> motif « jours » classique (pas NO_COMMON_HOURS)
  resetTestState(guildId);
  const noBoth = createCampaign(guildId, { title: 'TABLE RIEN', mjId: 'mj_r', roleId: 'role_r' });
  submitPlayerVote(guildId, noBoth.id, 'r1', ['9'], ['r1', 'r2'], { from: 18 * 60, to: 21 * 60 });
  const resNoBoth = submitPlayerVote(guildId, noBoth.id, 'r2', ['10'], ['r1', 'r2'], { from: 21 * 60, to: 24 * 60 });
  assert.strictEqual(resNoBoth.event, 'SHIFTED_NEXT_WEEK');
  assert.notStrictEqual(resNoBoth.conflictReason, 'NO_COMMON_HOURS');
  console.log('✅ Sans jour commun, le motif reste celui des jours.');

  console.log('\n🎉 TOUS LES TESTS SONT PASSÉS AVEC SUCCÈS !');
} catch (err) {
  console.error('\n❌ ÉCHEC D\'UN TEST :', err);
  process.exitCode = 1;
} finally {
  // Restaure le state.json initial
  if (fs.existsSync(backupStateFile)) {
    fs.copyFileSync(backupStateFile, testStateFile);
    fs.unlinkSync(backupStateFile);
  }
}
