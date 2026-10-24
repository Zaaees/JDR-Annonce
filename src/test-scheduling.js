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
    mjId: 'mj_2',
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
    mjId: 'mj_2',
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
  const invB = createCampaign(guildId, { title: 'TABLE CONTRAINTE', mjId: 'mj_2', roleId: 'role_c' });

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
  const hardB = createCampaign(guildId, { title: 'TABLE B UNIQUE', mjId: 'mj_2', roleId: 'role_hb' });

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
  const mjCampB = createCampaign(guildId, { title: 'TABLE SHADOWRUN', mjId: 'mj_2', roleId: 'role_sr' });

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
