/**
 * Accusé de réception « paresseux » des interactions Discord.
 *
 * Pourquoi : sur l'hébergement (IP partagée), Discord bloque par moments TOUTES les éditions
 * de réponse d'interaction (PATCH /webhooks/:id/:token/...) avec un 429 de près d'une heure,
 * sans en-têtes de rate limit. Le schéma classique deferReply/deferUpdate puis editReply
 * laissait alors le message bloqué sur « réfléchit… » ou le panneau figé.
 * Les réponses directes (POST /interactions/:id/:token/callback) passent, elles.
 *
 * Principe : deferReply()/deferUpdate() ne contactent plus Discord tout de suite.
 * Le premier editReply() envoie directement la réponse finale par le callback
 * (reply() ou update()). Si le traitement dépasse AUTO_DEFER_MS, le vrai accusé est envoyé
 * pour respecter la limite de 3 s de Discord, et l'editReply suivant repasse par l'édition classique.
 */
const AUTO_DEFER_MS = 2200;

function installLazyDefer(interaction, onError = () => {}) {
  const original = {
    deferReply: interaction.deferReply?.bind(interaction),
    deferUpdate: interaction.deferUpdate?.bind(interaction),
    editReply: interaction.editReply?.bind(interaction),
    reply: interaction.reply?.bind(interaction),
    update: interaction.update?.bind(interaction)
  };
  if (!original.deferReply || !original.editReply || !original.reply) return interaction;

  let pending = null; // { kind: 'reply' | 'update', flags }
  let timer = null;
  let flushPromise = null;

  const takePending = () => {
    const p = pending;
    pending = null;
    if (timer) clearTimeout(timer);
    timer = null;
    return p;
  };

  const flush = () => {
    const p = takePending();
    if (!p) return flushPromise;
    flushPromise = (p.kind === 'update'
      ? original.deferUpdate()
      : original.deferReply(p.flags !== undefined ? { flags: p.flags } : {})
    ).catch(err => {
      onError(err);
      throw err;
    });
    return flushPromise;
  };

  const schedule = p => {
    if (interaction.deferred || interaction.replied || pending || flushPromise) return;
    pending = p;
    timer = setTimeout(() => {
      flush().catch(() => null);
    }, AUTO_DEFER_MS);
    if (timer.unref) timer.unref();
  };

  interaction.deferReply = async (options = {}) => {
    schedule({ kind: 'reply', flags: options.flags });
  };

  if (original.deferUpdate && original.update) {
    interaction.deferUpdate = async () => {
      schedule({ kind: 'update' });
    };
  }

  interaction.editReply = async payload => {
    const p = takePending();
    if (p) {
      const body = typeof payload === 'string' ? { content: payload } : payload;
      if (p.kind === 'update') return original.update(body);
      return original.reply(p.flags !== undefined ? { ...body, flags: p.flags } : body);
    }
    if (flushPromise) await flushPromise;
    return original.editReply(payload);
  };

  interaction.reply = async payload => {
    takePending();
    if (flushPromise) await flushPromise;
    return original.reply(payload);
  };

  if (original.update) {
    interaction.update = async payload => {
      takePending();
      if (flushPromise) await flushPromise;
      return original.update(payload);
    };
  }

  /** Vrai si un accusé est en attente : la réponse finale partira par editReply(). */
  interaction.hasLazyDeferPending = () => pending !== null;

  return interaction;
}

module.exports = {
  installLazyDefer,
  AUTO_DEFER_MS
};
