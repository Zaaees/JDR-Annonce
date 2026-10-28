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

const BOOT_TIME = new Date().toISOString();
const recentLogs = [];
function logDiag(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  recentLogs.push(line);
  if (recentLogs.length > 50) recentLogs.shift();
}

let lastRestProbe = null;
async function probeDiscordRest() {
  const start = Date.now();
  try {
    const res = await fetch('https://discord.com/api/v10/gateway/bot', {
      headers: { Authorization: `Bot ${token}` }
    });
    const text = await res.text();
    lastRestProbe = {
      status: res.status,
      ms: Date.now() - start,
      retryAfter: res.headers.get('retry-after'),
      cfRay: res.headers.get('cf-ray'),
      bodyPreview: text.slice(0, 300)
    };
    logDiag(`Discord REST /gateway/bot -> HTTP ${res.status} (${lastRestProbe.ms}ms)`);
  } catch (err) {
    lastRestProbe = { error: err?.message, ms: Date.now() - start };
    logDiag(`Discord REST probe error: ${err?.message}`);
  }
}

// Serveur HTTP requis par Render (héberge aussi l'outil de recadrage interactif /crop/:token)
const port = process.env.PORT || 10000;
const server = http.createServer((req, res) => {
  if (req.url === '/status') {
    const state = loadState();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      bootTime: BOOT_TIME,
      ready: client.isReady(),
      user: client.user ? client.user.tag : null,
      wsStatus: client.ws ? client.ws.status : null,
      ping: client.ws ? client.ws.ping : null,
      guildsInCache: client.guilds ? client.guilds.cache.size : 0,
      guildsInState: Object.keys(state.guilds || {}).length,
      lastRestProbe,
      recentLogs
    }, null, 2));
    return;
  }
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

// Auto-ping toutes les 10 minutes sur Render pour éviter la mise en veille (cold start > 3s sur Discord)
const externalUrl = (process.env.RENDER_EXTERNAL_URL || process.env.APP_URL || '').replace(/\/+$/, '');
if (externalUrl) {
  setInterval(() => {
    fetch(`${externalUrl}/health`).catch(() => null);
  }, 10 * 60 * 1000).unref();
}

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
  logDiag(`Connecté en tant que ${readyClient.user.tag}`);
  await registerCommands(readyClient.user.id).catch(err =>
    logDiag(`Erreur enregistrement commandes: ${err?.message}`)
  );

  // Si Render a redémarré et réinitialisé le disque local, restaure automatiquement l'état depuis Discord
  await autoRecoverGuildsFromDiscord(client);
  logDiag('Auto-recovery terminé');

  // Rafraîchit les dashboards existants
  const state = loadState();
  for (const guildId of Object.keys(state.guilds)) {
    await refreshDashboardMessage(client, guildId).catch(err =>
      logDiag(`Erreur refresh startup (${guildId}): ${err?.message}`)
    );
  }
  logDiag('Startup refresh terminé');
});

client.on(Events.InteractionCreate, async interaction => {
  logDiag(`Interaction reçue: type=${interaction.type} customId=${interaction.customId || interaction.commandName}`);
  await handleInteraction(client, interaction);
});

client.on(Events.Error, err => {
  logDiag(`Client error: ${err?.message}`);
});

client.on(Events.Debug, info => {
  if (/429|rate|limit|Heartbeat|Session|Identify|Connecting|Connected|Destroy|Close/i.test(info)) {
    logDiag(`[WS] ${info}`);
  }
});

client.rest.on('rateLimited', info => {
  logDiag(`[REST 429] route=${info.route} retryAfter=${info.retryAfter}ms global=${info.global}`);
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

async function loginWithRetry() {
  await probeDiscordRest();
  try {
    await client.login(token);
  } catch (err) {
    logDiag(`Erreur login Discord: ${err?.message} — nouvelle tentative dans 2 min`);
    setTimeout(loginWithRetry, 2 * 60 * 1000).unref();
  }
}

// Si au bout de 2 minutes le client n'est toujours pas connecté (ex: blocage 429 Cloudflare), on relance
setInterval(async () => {
  if (!client.isReady()) {
    await probeDiscordRest();
    if (lastRestProbe && lastRestProbe.status === 200 && !client.isReady()) {
      logDiag('API Discord de nouveau accessible (HTTP 200) -> reconnexion du bot...');
      client.destroy().catch(() => null);
      client.login(token).catch(err => logDiag(`Erreur relance login: ${err?.message}`));
    }
  }
}, 2 * 60 * 1000).unref();

loginWithRetry();
