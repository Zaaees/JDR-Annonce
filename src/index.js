require('dotenv').config();
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events
} = require('discord.js');
const {
  getSlashCommands,
  handleInteraction
} = require('./bot/interactions');
const {
  refreshDashboardMessage,
  autoRecoverGuildsFromDiscord,
  sendRolePing
} = require('./bot/dashboardManager');
const {
  loadState,
  checkAndRollOverFinishedSessions
} = require('./storage/store');
const {
  getWeekDaysFromMonday
} = require('./utils/dates');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN manquant dans le fichier .env ou les variables Render');
  process.exit(1);
}

// Serveur HTTP léger requis par Render (offre gratuite "Web Service") pour maintenir le processus actif
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot JDR en ligne');
});
server.on('error', () => {
  // Ignore si le port local est déjà occupé en développement
});
server.listen(port, '0.0.0.0', () => {
  console.log(`Serveur HTTP Health-Check actif sur le port ${port}`);
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ]
});

async function registerCommands(appId) {
  const rest = new REST({ version: '10' }).setToken(token);
  const commands = getSlashCommands();

  if (process.env.GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(appId, process.env.GUILD_ID),
      { body: commands }
    );
    console.log(`Commandes /jdr enregistrées sur le serveur ${process.env.GUILD_ID}`);
  } else {
    await rest.put(
      Routes.applicationCommands(appId),
      { body: commands }
    );
    console.log('Commandes /jdr enregistrées globalement');
  }
}

async function runSessionRolloverCheck() {
  const rolledOver = checkAndRollOverFinishedSessions();
  if (rolledOver.length === 0) return;

  const affectedGuilds = new Set();
  for (const { guildId, campaign } of rolledOver) {
    affectedGuilds.add(guildId);
    const weekDays = getWeekDaysFromMonday(campaign.weekMondayISO);
    await sendRolePing(
      client,
      guildId,
      campaign,
      `Nouveau sondage de disponibilité pour **${campaign.title}** (semaine du ${weekDays[0].fullLabel}).`
    );
  }

  for (const guildId of affectedGuilds) {
    await refreshDashboardMessage(client, guildId);
  }
}

client.once(Events.ClientReady, async readyClient => {
  console.log(`Connecté en tant que ${readyClient.user.tag}`);
  await registerCommands(readyClient.user.id).catch(err =>
    console.error('Erreur enregistrement commandes:', err)
  );

  // Si Render a redémarré et réinitialisé le disque local, restaure automatiquement l'état depuis l'image sur Discord
  await autoRecoverGuildsFromDiscord(client);

  // Rafraîchit les dashboards existants
  const state = loadState();
  for (const guildId of Object.keys(state.guilds)) {
    await refreshDashboardMessage(client, guildId).catch(() => null);
  }

  // Vérifie toutes les minutes si une session est passée pour relancer automatiquement le sondage
  await runSessionRolloverCheck();
  setInterval(runSessionRolloverCheck, 60 * 1000);
});

client.on(Events.InteractionCreate, async interaction => {
  await handleInteraction(client, interaction);
});

// Si les rôles d'un membre changent (ajout/retrait d'un joueur dans un @Rôle JDR), met à jour le tableau
client.on(Events.GuildMemberUpdate, async (oldMember, newMember) => {
  if (oldMember.roles.cache.equals(newMember.roles.cache)) return;
  const state = loadState();
  const guildData = state.guilds[newMember.guild.id];
  if (!guildData || !guildData.campaigns.length) return;

  const roleChangedForCampaign = guildData.campaigns.some(c =>
    oldMember.roles.cache.has(c.roleId) !== newMember.roles.cache.has(c.roleId)
  );
  if (roleChangedForCampaign) {
    await refreshDashboardMessage(client, newMember.guild.id).catch(() => null);
  }
});

client.login(token);
