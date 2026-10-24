/**
 * File d'attente asynchrone (mutex) par clé.
 *
 * Les tâches partageant la même clé sont exécutées STRICTEMENT l'une après l'autre,
 * dans leur ordre d'arrivée, même si elles contiennent des `await` (appels Discord, etc.).
 * Les tâches de clés différentes (ex : deux serveurs Discord) restent parallèles.
 *
 * Usage :
 *   await runExclusive(`mutation:${guildId}`, async () => { ... });
 *
 * Attention : le verrou n'est PAS réentrant. Une tâche ne doit pas appeler runExclusive
 * avec la même clé qu'elle détient déjà (deadlock). On utilise donc des clés distinctes
 * selon le niveau : `mutation:` (changements d'état + notifications) et `refresh:` (affichage).
 */
const tails = new Map();

function runExclusive(key, task) {
  const previous = tails.get(key) || Promise.resolve();

  // On attend la fin de la tâche précédente (qu'elle ait réussi ou échoué) avant de démarrer
  const run = previous.then(() => task());

  // La queue ne doit jamais rester bloquée par une erreur : on avale l'erreur pour la suite
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  tails.set(key, tail);

  // Nettoyage mémoire quand plus aucune tâche n'attend derrière
  tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });

  return run;
}

/**
 * Nombre de clés actuellement actives (utile pour les tests).
 */
function getActiveLockCount() {
  return tails.size;
}

module.exports = {
  runExclusive,
  getActiveLockCount
};
