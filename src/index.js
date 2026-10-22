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
  loadState
} = require('./storage/store');
const {
  getWeekDaysFromMonday
} = require('./utils/dates');
const { handleCropHttp } = require('./server/cropServer');

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN manquant dans le fichier .env ou les variables Render');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ]
});

// Serveur HTTP requis par Render (héberge aussi l'outil de recadrage interactif /crop/:token)
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  if (handleCropHttp(req, res, client)) {
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Bot JDR en ligne');
});
server.on('error', () => {
  // Ignore si le port local est déjà occupé en développement
});
server.listen(port, '0.0.0.0', () => {
  console.log(`Serveur HTTP actif sur le port ${port}`);
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

client.once(Events.ClientReady, async readyClient => {
  console.log(`Connecté en tant que ${readyClient.user.tag}`);
  await registerCommands(readyClient.user.id).catch(err =>
    console.error('Erreur enregistrement commandes:', err)
  );

  // Si Render a redémarré et réinitialisé le disque local, restaure automatiquement l'état depuis Discord
  await autoRecoverGuildsFromDiscord(client);

  // Rafraîchit les dashboards existants
  const state = loadState();
  for (const guildId of Object.keys(state.guilds)) {
    await refreshDashboardMessage(client, guildId).catch(() => null);
  }
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
