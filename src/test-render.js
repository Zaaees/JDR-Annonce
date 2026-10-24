const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { renderDashboardBuffer, renderCampaignCardBuffer } = require('./renderer/boardRenderer');
const { embedStateInPng, extractStateFromPng } = require('./utils/pngState');
const {
  createCampaign,
  submitPlayerVote,
  deleteCampaign,
  getGuildState
} = require('./storage/store');
const {
  getTodayISO,
  getMondayISO,
  getRollingDays,
  addDaysISO
} = require('./utils/dates');

async function runTests() {
  const testGuildId = 'test_guild_123';
  const roleMembers = ['u1', 'u2', 'u3'];

  // Test unitaire des dates : 14 jours (2 semaines du Lundi au Dimanche)
  const mondayISO = getMondayISO();
  const twoWeeksDays = getRollingDays(mondayISO, 14);
  assert.strictEqual(twoWeeksDays.length, 14, 'Doit générer exactement 14 jours');
  assert.strictEqual(twoWeeksDays[0].code, 'LUN', 'Le premier jour doit être un LUNDI');
  assert.strictEqual(twoWeeksDays[6].code, 'DIM', 'Le 7ème jour doit être un DIMANCHE (fin S1)');
  assert.strictEqual(twoWeeksDays[7].code, 'LUN', 'Le 8ème jour doit être un LUNDI (début S2)');
  assert.strictEqual(twoWeeksDays[13].code, 'DIM', 'Le 14ème jour doit être un DIMANCHE (fin S2)');
  assert.strictEqual(twoWeeksDays[13].iso, addDaysISO(mondayISO, 13), 'Le 14ème jour doit être à J+13 du premier lundi');

  // 1. Création d'une table et test du report immédiat via "Indisponible" + blocage au bout de 2 périodes (4 semaines)
  const c1 = createCampaign(testGuildId, {
    title: 'Test Cyberpunk',
    mjId: 'mj1',
    mjName: 'Nexus',
    roleId: 'role1',
    roleName: '@Runners',
    theme: 'cyberpunk',
    time: '21h00'
  });

  assert.strictEqual(c1.startDateISO, mondayISO, 'La table doit commencer le lundi');

  // Période 1 : u1 clique sur "Indisponible" -> bascule immédiatement aux 2 semaines suivantes (+14 jours)
  const res1 = submitPlayerVote(testGuildId, c1.id, 'u1', ['UNAVAILABLE'], roleMembers);
  assert.strictEqual(res1.event, 'SHIFTED_NEXT_WEEK', 'Doit passer immédiatement à la période suivante');
  assert.strictEqual(res1.campaign.status, 'poll');
  assert.strictEqual(res1.campaign.startDateISO, addDaysISO(mondayISO, 14), 'La nouvelle période doit démarrer 14 jours plus tard');

  // Période 2 : tous votent mais aucun jour en commun -> passe en "unavailable" (2 périodes de 2 semaines sans dispo)
  submitPlayerVote(testGuildId, c1.id, 'u1', ['0'], roleMembers);
  submitPlayerVote(testGuildId, c1.id, 'u2', ['1'], roleMembers);
  const res2 = submitPlayerVote(testGuildId, c1.id, 'u3', ['2'], roleMembers);
  assert.strictEqual(res2.event, 'UNAVAILABLE_2_WEEKS', 'Doit bloquer après 2 périodes sans dispo');
  assert.strictEqual(res2.campaign.status, 'unavailable');
  assert.ok(res2.campaign.unavailableUntilISO, 'Doit renseigner la date de fin des 2 semaines');

  // 2. Test de l'auto-lock sur le 12ème jour (indice 11 : Vendredi S2) où 100% du @Rôle est disponible
  const c2 = createCampaign(testGuildId, {
    title: 'Test Dragons',
    mjId: 'mj1',
    mjName: 'Aldebaran',
    roleId: 'role2',
    roleName: '@Dragons',
    theme: 'fantasy',
    time: '21h00'
  });

  submitPlayerVote(testGuildId, c2.id, 'u1', ['3', '11'], roleMembers);
  submitPlayerVote(testGuildId, c2.id, 'u2', ['1', '3', '11'], roleMembers);
  const res3 = submitPlayerVote(testGuildId, c2.id, 'u3', ['11'], roleMembers);
  assert.strictEqual(res3.event, 'AUTO_CONFIRMED', 'Doit verrouiller automatiquement le premier jour commun (indice 11)');
  assert.strictEqual(res3.campaign.status, 'confirmed');
  const c2Days = getRollingDays(c2.startDateISO, 14);
  assert.strictEqual(res3.campaign.confirmedDateISO, c2Days[11].iso, 'La date confirmée doit être le 12ème jour');

  // 3. Test du rendu PNG via @napi-rs/canvas avec 2 rangées de 7 jours (Option A)
  const pngBuffer = await renderDashboardBuffer([
    {
      ...res3.campaign,
      players: [
        { id: 'u1', name: 'Lyra', voted: true, days: [3, 11] },
        { id: 'u2', name: 'Thorin', voted: true, days: [1, 3, 11] },
        { id: 'u3', name: 'Kael', voted: true, days: [11] }
      ]
    },
    {
      ...res2.campaign,
      players: [
        { id: 'u1', name: 'Ghost', voted: false, days: [] },
        { id: 'u2', name: 'Zero', voted: false, days: [] },
        { id: 'u3', name: 'Raze', voted: false, days: [] }
      ]
    }
  ]);

  assert.ok(Buffer.isBuffer(pngBuffer) && pngBuffer.length > 5000, 'Le buffer PNG généré doit être valide');

  // Test du rendu individuel par table JDR (Option B : Components V2 / Galerie)
  const singleCardBuffer = await renderCampaignCardBuffer({
    ...res3.campaign,
    players: [
      { id: 'u1', name: 'Lyra', voted: true, days: [3, 5] },
      { id: 'u2', name: 'Thorin', voted: true, days: [1, 3, 5] }
    ]
  }, 0);
  assert.ok(Buffer.isBuffer(singleCardBuffer) && singleCardBuffer.length > 5000, 'Le buffer PNG de la carte individuelle doit être valide');

  // Test des états "paused" et "prep"
  const pausedBuffer = await renderCampaignCardBuffer({
    ...res3.campaign,
    status: 'paused',
    players: []
  }, 0);
  assert.ok(Buffer.isBuffer(pausedBuffer) && pausedBuffer.length > 5000, 'Le buffer PNG de la table en pause doit être valide');

  const prepBuffer = await renderCampaignCardBuffer({
    ...res3.campaign,
    status: 'prep',
    players: []
  }, 0);
  assert.ok(Buffer.isBuffer(prepBuffer) && prepBuffer.length > 5000, 'Le buffer PNG de la table en préparation doit être valide');

  // 4. Test de la sauvegarde et restauration d'état intégrée dans les métadonnées du PNG (pour Render Free)
  const { guild: guildStateBefore } = getGuildState(testGuildId);
  const pngWithState = embedStateInPng(pngBuffer, guildStateBefore);
  const extractedState = extractStateFromPng(pngWithState);
  assert.ok(extractedState && extractedState.campaigns.length === 2, 'Les campagnes et votes doivent être restaurés depuis le PNG');
  assert.strictEqual(extractedState.campaigns[1].confirmedDateISO, res3.campaign.confirmedDateISO);

  // Nettoyage des données de test
  deleteCampaign(testGuildId, c1.id);
  deleteCampaign(testGuildId, c2.id);
  const statePath = path.join(__dirname, '..', 'data', 'state.json');
  if (fs.existsSync(statePath)) {
    fs.unlinkSync(statePath);
  }

  console.log(`Tests réussis ! Image PNG générée (${pngBuffer.length} octets).`);
}

runTests().catch(err => {
  console.error(err);
  process.exit(1);
});
