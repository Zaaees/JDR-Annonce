const assert = require('assert');
const { runExclusive, getActiveLockCount } = require('./utils/mutex');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function runTests() {
  console.log('🧪 TESTS DE LA FILE D\'ATTENTE (MUTEX)\n');

  // 1. Sans verrou, un « lire -> attendre -> écrire » concurrent perd des mises à jour.
  //    Avec runExclusive, aucune mise à jour n'est perdue.
  let counter = 0;
  const increment = async () => {
    const read = counter;
    await sleep(Math.random() * 10);
    counter = read + 1;
  };

  await Promise.all(Array.from({ length: 20 }, () => increment()));
  assert.ok(counter < 20, 'Sanity check : sans verrou, des mises à jour concurrentes doivent se perdre');

  counter = 0;
  await Promise.all(Array.from({ length: 20 }, () => runExclusive('guild_a', increment)));
  assert.strictEqual(counter, 20, 'Avec le verrou, les 20 incréments doivent tous être comptés');
  console.log('✅ Les tâches concurrentes sont sérialisées sans perte de mise à jour.');

  // 2. Ordre d'arrivée respecté (FIFO)
  const order = [];
  await Promise.all(
    [30, 5, 15, 1].map((delay, i) =>
      runExclusive('guild_b', async () => {
        await sleep(delay);
        order.push(i);
      })
    )
  );
  assert.deepStrictEqual(order, [0, 1, 2, 3], 'Les tâches doivent s\'exécuter dans leur ordre d\'arrivée');
  console.log('✅ Ordre d\'arrivée (FIFO) respecté.');

  // 3. Une erreur ne bloque pas la file et est bien propagée à son appelant
  const results = await Promise.allSettled([
    runExclusive('guild_c', async () => {
      throw new Error('boom');
    }),
    runExclusive('guild_c', async () => 'ok')
  ]);
  assert.strictEqual(results[0].status, 'rejected');
  assert.strictEqual(results[0].reason.message, 'boom');
  assert.strictEqual(results[1].status, 'fulfilled');
  assert.strictEqual(results[1].value, 'ok');
  console.log('✅ Une erreur est propagée à son appelant sans bloquer la file.');

  // 4. Des clés différentes s'exécutent en parallèle (serveurs indépendants)
  const start = Date.now();
  await Promise.all([
    runExclusive('guild_d', () => sleep(60)),
    runExclusive('guild_e', () => sleep(60))
  ]);
  assert.ok(Date.now() - start < 110, 'Deux serveurs différents ne doivent pas s\'attendre');
  console.log('✅ Les serveurs différents restent parallèles.');

  // 5. Nettoyage mémoire
  await sleep(10);
  assert.strictEqual(getActiveLockCount(), 0, 'Les verrous inactifs doivent être libérés');
  console.log('✅ Aucun verrou résiduel en mémoire.');

  console.log('\n🎉 TOUS LES TESTS MUTEX SONT PASSÉS AVEC SUCCÈS !');
}

runTests().catch(err => {
  console.error('\n❌ ÉCHEC D\'UN TEST MUTEX :', err);
  process.exitCode = 1;
});
