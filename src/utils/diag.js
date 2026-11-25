/**
 * Journal de diagnostic partagé : écrit dans la console (logs Render)
 * et garde les 300 dernières lignes, exposées par l'endpoint HTTP /status.
 */
const recentLogs = [];

function logDiag(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  recentLogs.push(line);
  if (recentLogs.length > 300) recentLogs.shift();
}

/**
 * Chronomètre les réponses Discord d'une interaction (defer, editReply, reply...)
 * et signale toute interaction encore sans réponse finale après 10 s.
 */
function traceInteraction(interaction) {
  const start = Date.now();
  const label = `${interaction.customId || interaction.commandName || interaction.type}#${interaction.id.slice(-5)}`;
  let finished = false;

  for (const method of ['deferReply', 'deferUpdate', 'reply', 'editReply', 'update', 'showModal', 'followUp']) {
    const original = interaction[method];
    if (typeof original !== 'function') continue;
    interaction[method] = async function tracedMethod(...args) {
      const callStart = Date.now();
      logDiag(`[Trace ${label}] ${method} -> envoi (t+${callStart - start}ms)`);
      try {
        const result = await original.apply(this, args);
        logDiag(`[Trace ${label}] ${method} OK en ${Date.now() - callStart}ms`);
        if (method !== 'deferReply' && method !== 'deferUpdate') finished = true;
        return result;
      } catch (err) {
        logDiag(`[Trace ${label}] ${method} ÉCHEC en ${Date.now() - callStart}ms : ${err?.code || ''} ${err?.message}`);
        throw err;
      }
    };
  }

  const watchdog = setInterval(() => {
    if (finished) {
      clearInterval(watchdog);
      return;
    }
    const elapsed = Date.now() - start;
    logDiag(`[Trace ${label}] toujours sans réponse finale après ${Math.round(elapsed / 1000)}s`);
    if (elapsed > 16 * 60 * 1000) clearInterval(watchdog);
  }, 10 * 1000);
  watchdog.unref();

  return {
    step(name) {
      logDiag(`[Trace ${label}] étape « ${name} » (t+${Date.now() - start}ms)`);
    },
    done() {
      finished = true;
      clearInterval(watchdog);
    }
  };
}

module.exports = {
  logDiag,
  recentLogs,
  traceInteraction
};
