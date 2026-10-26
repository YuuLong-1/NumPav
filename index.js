import { Client, GatewayIntentBits, Events, PermissionsBitField } from 'discord.js';
import { DisTube } from 'distube';
import { YouTubePlugin } from '@distube/youtube';
import ffmpeg from 'ffmpeg-static';
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';

dotenv.config();

if (!process.env.DISCORD_TOKEN) {
  console.error('Error: DISCORD_TOKEN is not defined in your .env file!');
  process.exit(1);
}

// --- 24/7 Mode Settings Storage & Management ---
const SETTINGS_FILE = path.resolve('settings.json');

function loadSettings() {
  try {
    if (!fs.existsSync(SETTINGS_FILE)) {
      const defaultSettings = { guilds: {} };
      fs.writeFileSync(SETTINGS_FILE, JSON.stringify(defaultSettings, null, 2), 'utf-8');
      return defaultSettings;
    }
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('[Settings] Failed to load settings.json:', err.message);
    return { guilds: {} };
  }
}

function saveSettings(settings) {
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Settings] Failed to save settings.json:', err.message);
  }
}

function getGuild247(guildId) {
  const settings = loadSettings();
  return settings.guilds?.[guildId]?.twentyFourSeven || null;
}

function is247Enabled(guildId) {
  const config = getGuild247(guildId);
  return Boolean(config?.enabled);
}

function setGuild247(guildId, { enabled, voiceChannelId, textChannelId }) {
  const settings = loadSettings();
  if (!settings.guilds) settings.guilds = {};
  if (!settings.guilds[guildId]) settings.guilds[guildId] = {};

  const existing = settings.guilds[guildId].twentyFourSeven || {};
  settings.guilds[guildId].twentyFourSeven = {
    enabled,
    voiceChannelId: voiceChannelId || existing.voiceChannelId || null,
    textChannelId: textChannelId || existing.textChannelId || null,
    updatedAt: new Date().toISOString(),
  };

  saveSettings(settings);
}

const reconnectingGuilds = new Set();
const manualDisconnectGuilds = new Set();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates, // REQUIRED for joining voice channels
    GatewayIntentBits.MessageContent,   // REQUIRED for reading bot commands
  ],
});

// Initialize DisTube for audio streaming with YouTube support
const distube = new DisTube(client, {
  emitNewSongOnly: true,
  ffmpeg: {
    path: ffmpeg || 'ffmpeg',
  },
  plugins: [new YouTubePlugin()],
});

// Helper to reconnect or join a 24/7 channel
async function ensure247Connection(guildId) {
  const config = getGuild247(guildId);
  if (!config || !config.enabled || !config.voiceChannelId) return;

  if (reconnectingGuilds.has(guildId)) return;
  reconnectingGuilds.add(guildId);

  try {
    const guild = await client.guilds.fetch(guildId).catch(() => null);
    if (!guild) return;

    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    // If already connected to target channel, nothing to do
    if (me?.voice?.channelId === config.voiceChannelId) {
      return;
    }

    const voiceChannel = await guild.channels.fetch(config.voiceChannelId).catch(() => null);
    if (!voiceChannel || !voiceChannel.isVoiceBased()) {
      console.warn(`[24/7] Target channel ${config.voiceChannelId} not found or not a voice channel in guild "${guild.name}".`);
      return;
    }

    const permissions = voiceChannel.permissionsFor(me);
    if (!permissions?.has(PermissionsBitField.Flags.Connect)) {
      console.warn(`[24/7] Missing CONNECT permission for "${voiceChannel.name}" in guild "${guild.name}".`);
      return;
    }

    console.log(`[24/7] Connecting to "${voiceChannel.name}" in "${guild.name}"...`);
    await distube.voices.join(voiceChannel);
    console.log(`[24/7] Successfully connected to "${voiceChannel.name}" in "${guild.name}"!`);
  } catch (err) {
    console.error(`[24/7] Failed to connect in guild ${guildId}:`, err.message);
  } finally {
    reconnectingGuilds.delete(guildId);
  }
}

// Bot ready event
client.once(Events.ClientReady, async () => {
  console.log(`🎵 Logged in as ${client.user.tag}! Ready to play music.`);

  // Auto-connect to all guilds configured for 24/7 mode
  const settings = loadSettings();
  const guildIds = Object.keys(settings.guilds || {});
  for (const guildId of guildIds) {
    if (settings.guilds[guildId]?.twentyFourSeven?.enabled) {
      await ensure247Connection(guildId);
    }
  }

  // Periodic health check (every 30 seconds) to ensure 24/7 channels stay connected
  setInterval(() => {
    const currentSettings = loadSettings();
    for (const [guildId, data] of Object.entries(currentSettings.guilds || {})) {
      if (data?.twentyFourSeven?.enabled && data.twentyFourSeven.voiceChannelId) {
        const guild = client.guilds.cache.get(guildId);
        const currentChannelId = guild?.members?.me?.voice?.channelId;
        if (currentChannelId !== data.twentyFourSeven.voiceChannelId) {
          ensure247Connection(guildId);
        }
      }
    }
  }, 30000);
});

// Handle voice state updates (auto-reconnect when disconnected or moved)
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
  if (newState.id !== client.user?.id) return;

  const guildId = newState.guild.id;
  const config = getGuild247(guildId);
  if (!config || !config.enabled) return;

  // Bot was moved to another channel
  if (newState.channelId && newState.channelId !== oldState.channelId) {
    if (newState.channelId !== config.voiceChannelId) {
      console.log(`[24/7] Bot moved to channel ${newState.channelId}. Updating 24/7 target.`);
      setGuild247(guildId, {
        enabled: true,
        voiceChannelId: newState.channelId,
        textChannelId: config.textChannelId,
      });
    }
    return;
  }

  // Bot was disconnected
  if (!newState.channelId && oldState.channelId) {
    if (manualDisconnectGuilds.has(guildId)) {
      manualDisconnectGuilds.delete(guildId);
      return;
    }

    console.log(`[24/7] Bot disconnected from voice channel in "${newState.guild.name}". Reconnecting in 3 seconds...`);
    setTimeout(() => {
      ensure247Connection(guildId);
    }, 3000);
  }
});

// Listen for incoming messages
client.on(Events.MessageCreate, async (message) => {
  // Ignore messages from bots or outside a guild
  if (message.author.bot || !message.guild) return;

  const content = message.content.trim();
  if (!content.startsWith('!')) return;

  const args = content.slice(1).trim().split(/\s+/);
  const command = args.shift().toLowerCase();

  // Basic commands
  if (command === 'ping') {
    return message.reply('Pong! 🏓');
  }

  if (command === 'hello') {
    return message.channel.send(`Hello there, ${message.author}! 👋`);
  }

  // !join / !connect / !summon
  if (command === 'join' || command === 'connect' || command === 'summon') {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('❌ You need to join a voice channel first!');
    }

    const permissions = voiceChannel.permissionsFor(message.guild.members.me);
    if (!permissions?.has(PermissionsBitField.Flags.Connect)) {
      return message.reply(`❌ I don't have permission to connect to **${voiceChannel.name}**!`);
    }
    if (!permissions?.has(PermissionsBitField.Flags.Speak)) {
      return message.reply(`❌ I don't have permission to speak in **${voiceChannel.name}**!`);
    }

    try {
      await distube.voices.join(voiceChannel);
      return message.reply(`🔊 Joined **${voiceChannel.name}**!`);
    } catch (err) {
      console.error('Join error:', err);
      return message.reply(`❌ Could not join voice channel: ${err.message}`);
    }
  }

  // !leave / !disconnect / !dc
  if (command === 'leave' || command === 'disconnect' || command === 'dc') {
    const botVoiceChannel = message.guild.members.me?.voice?.channel;
    if (!botVoiceChannel) {
      return message.reply('❌ I am not in any voice channel!');
    }

    // Flag as manual disconnect so 24/7 auto-reconnect does not fight this action
    manualDisconnectGuilds.add(message.guild.id);

    const was247 = is247Enabled(message.guild.id);
    if (was247) {
      setGuild247(message.guild.id, { enabled: false });
    }

    try {
      const queue = distube.getQueue(message);
      if (queue) {
        await distube.stop(message);
      }
      distube.voices.leave(message.guild);
      return message.reply(
        `👋 Left **${botVoiceChannel.name}**!${
          was247 ? '\n*(24/7 mode has been turned off. Use `!247` or `!join` to bring me back.)*' : ''
        }`
      );
    } catch (err) {
      console.error('Leave error:', err);
      return message.reply(`❌ Error leaving channel: ${err.message}`);
    }
  }

  // !247 / !24/7 / !stay / !stayvc
  if (command === '247' || command === '24/7' || command === 'stay' || command === 'stayvc') {
    const subCommand = args[0]?.toLowerCase();
    const currentConfig = getGuild247(message.guild.id);
    const isCurrentlyEnabled = Boolean(currentConfig?.enabled);

    // Status check: !247 status
    if (subCommand === 'status') {
      if (isCurrentlyEnabled) {
        const channelMention = currentConfig.voiceChannelId ? `<#${currentConfig.voiceChannelId}>` : 'Unknown';
        const botVoiceChannel = message.guild.members.me?.voice?.channel;
        const isConnected = botVoiceChannel?.id === currentConfig.voiceChannelId;
        return message.reply(
          `🟢 **24/7 Mode is currently ENABLED**\n` +
          `• Target Voice Channel: ${channelMention}\n` +
          `• Current Status: ${isConnected ? 'Connected 🟢' : 'Reconnecting 🟡'}\n` +
          `• Use \`!247 off\` to disable.`
        );
      } else {
        return message.reply(
          `🔴 **24/7 Mode is currently DISABLED**\n` +
          `• Use \`!247 on\` to make the bot stay in your voice channel 24/7.`
        );
      }
    }

    // Determine target state (toggle if no arg or toggle arg given)
    let enable = !isCurrentlyEnabled;
    if (subCommand === 'on' || subCommand === 'enable') enable = true;
    if (subCommand === 'off' || subCommand === 'disable') enable = false;

    if (!enable) {
      setGuild247(message.guild.id, { enabled: false });
      return message.reply('🔴 **24/7 Mode Disabled!** The bot will no longer stay in the voice channel permanently.');
    }

    // To enable, determine which voice channel to stay in:
    // Prefer the user's voice channel, or fallback to the bot's current channel
    const voiceChannel = message.member?.voice?.channel || message.guild.members.me?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('❌ You must be in a voice channel (or summon the bot first) to enable 24/7 mode!');
    }

    const permissions = voiceChannel.permissionsFor(message.guild.members.me);
    if (!permissions?.has(PermissionsBitField.Flags.Connect)) {
      return message.reply(`❌ I don't have permission to join **${voiceChannel.name}**!`);
    }
    if (!permissions?.has(PermissionsBitField.Flags.Speak)) {
      return message.reply(`❌ I don't have permission to speak in **${voiceChannel.name}**!`);
    }

    setGuild247(message.guild.id, {
      enabled: true,
      voiceChannelId: voiceChannel.id,
      textChannelId: message.channel.id,
    });

    // Join the voice channel if not already in it
    if (message.guild.members.me?.voice?.channelId !== voiceChannel.id) {
      try {
        await distube.voices.join(voiceChannel);
      } catch (err) {
        console.error('Failed to join voice channel on 24/7 enable:', err);
        return message.reply(`⚠️ 24/7 Mode saved, but failed to join immediately: ${err.message}`);
      }
    }

    return message.reply(
      `🟢 **24/7 Mode Enabled!**\n` +
      `I will stay in <#${voiceChannel.id}> 24/7 and auto-reconnect if disconnected or after bot restarts.\n` +
      `Use \`!247 off\` to disable anytime.`
    );
  }

  // !play <song name or URL>
  if (command === 'play') {
    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) {
      return message.reply('❌ You need to join a voice channel first!');
    }

    const query = args.join(' ');
    if (!query) {
      return message.reply('❌ Please provide a song name or YouTube link!');
    }

    message.reply(`🔍 Searching and playing: **${query}**`);

    try {
      await distube.play(voiceChannel, query, {
        textChannel: message.channel,
        member: message.member,
      });
    } catch (err) {
      console.error('Play error:', err);
      message.channel.send(`❌ Error while attempting to play: ${err.message}`);
    }
    return;
  }

  // !autoplay / !autosong / !auto
  if (command === 'autoplay' || command === 'autosong' || command === 'auto' || command === 'playauto') {
    const subCommand = args[0]?.toLowerCase();

    // If user provided a specific toggle argument: "on" or "off"
    if (subCommand === 'on' || subCommand === 'off') {
      const queue = distube.getQueue(message);
      if (!queue) {
        return message.reply('❌ There is no music playing right now!');
      }

      queue.autoplay = subCommand === 'on';
      return message.reply(
        `🔄 Autoplay is now **${queue.autoplay ? 'Enabled (ON)' : 'Disabled (OFF)'}**! The bot will ${
          queue.autoplay ? 'automatically play related songs when the queue ends.' : 'stop when the queue ends.'
        }`
      );
    }

    // If arguments are provided and they are NOT "on" / "off", treat it as a query to play with autoplay enabled
    if (args.length > 0) {
      const voiceChannel = message.member?.voice?.channel;
      if (!voiceChannel) {
        return message.reply('❌ You need to join a voice channel first!');
      }

      const query = args.join(' ');
      message.reply(`🔍 Searching and playing: **${query}** with 🔄 **Autoplay enabled**!`);

      try {
        await distube.play(voiceChannel, query, {
          textChannel: message.channel,
          member: message.member,
        });
        const queue = distube.getQueue(message);
        if (queue) {
          queue.autoplay = true;
        }
      } catch (err) {
        console.error('Play error:', err);
        message.channel.send(`❌ Error while attempting to play: ${err.message}`);
      }
      return;
    }

    // If no argument is passed, toggle autoplay for the current queue
    const queue = distube.getQueue(message);
    if (!queue) {
      return message.reply(
        '❌ There is no music playing right now! Use `!autosong <song name>` or `!play <song name>` to start playing.'
      );
    }

    const autoplayState = distube.toggleAutoplay(message);
    return message.reply(
      `🔄 Autoplay is now **${autoplayState ? 'Enabled (ON)' : 'Disabled (OFF)'}**! The bot will ${
        autoplayState ? 'automatically play related songs when the queue ends.' : 'stop when the queue ends.'
      }`
    );
  }

  // !skip
  if (command === 'skip') {
    const queue = distube.getQueue(message);
    if (!queue) {
      return message.reply('❌ There is no music playing right now!');
    }

    try {
      await distube.skip(message);
      message.reply('⏭️ Skipped to the next song!');
    } catch (e) {
      message.reply('❌ No more songs left in the queue to skip to!');
    }
    return;
  }

  // !stop
  if (command === 'stop') {
    const queue = distube.getQueue(message);
    if (!queue) {
      return message.reply('❌ There is no music playing right now!');
    }

    try {
      await distube.stop(message);
      message.reply('⏹️ Stopped the music and cleared the queue!');
    } catch (e) {
      console.error('Stop error:', e);
      message.reply(`❌ Could not stop: ${e.message}`);
    }
    return;
  }

  // !queue
  if (command === 'queue') {
    const queue = distube.getQueue(message);
    if (!queue || !queue.songs || queue.songs.length === 0) {
      return message.reply('❌ There is no music playing right now!');
    }

    const q = queue.songs
      .map((song, i) => `${i === 0 ? '▶️ Now Playing:' : `${i}.`} **${song.name}** - \`${song.formattedDuration}\``)
      .slice(0, 10)
      .join('\n');

    const autoplayStatus = queue.autoplay ? '✅ Enabled (ON)' : '❌ Disabled (OFF)';
    message.channel.send(`🎶 **Current Queue:**\n${q}\n\n🔄 **Autoplay:** ${autoplayStatus}`);
    return;
  }

  // !help
  if (command === 'help') {
    const helpText = [
      '**Available Commands:**',
      '`!play <song name or link>` - Play music or add to queue',
      '`!autosong [query]` - Play a song with autoplay or toggle autoplay for current queue',
      '`!autoplay [on|off]` - Toggle or set autoplay mode on/off',
      '`!skip` - Skip current track',
      '`!stop` - Stop playing and clear queue',
      '`!queue` - Display current queue and autoplay status',
      '`!247 [on|off|status]` - Keep the bot in voice channel 24/7 (auto-reconnects)',
      '`!join` - Summon the bot to your voice channel',
      '`!leave` - Disconnect the bot from the voice channel',
      '`!ping` - Test bot latency/responsiveness',
      '`!hello` - Greet the bot',
    ].join('\n');
    return message.channel.send(helpText);
  }
});

// Triggered when a song starts playing
distube.on('playSong', (queue, song) => {
  const isAutoplay = song.user?.id === client.user?.id || !song.user;
  const requester = isAutoplay ? '🤖 Autoplay' : song.user;
  queue.textChannel?.send(
    `🎶 Now playing: **${song.name}** - \`${song.formattedDuration}\` (Requested by: ${requester})`
  );
});

// Triggered when autoplay cannot find a related song
distube.on('noRelated', (queue) => {
  queue.textChannel?.send('⚠️ Autoplay could not find any related songs to play next.');
});

// Triggered when a song is added to the queue
distube.on('addSong', (queue, song) => {
  queue.textChannel?.send(`✅ Added **${song.name}** to the queue!`);
});

// Triggered when queue finishes
distube.on('finish', (queue) => {
  const is247 = is247Enabled(queue.id);
  queue.textChannel?.send(
    `🏁 Finished playing all songs in the queue.${is247 ? ' (24/7 Mode active — staying in voice channel)' : ''}`
  );
});

// Triggered when voice channel is empty
distube.on('empty', (queue) => {
  const is247 = is247Enabled(queue.id);
  if (!is247) {
    queue.textChannel?.send('🔇 Voice channel is empty.');
  }
});

// Handle errors gracefully
distube.on('error', (error, queue) => {
  console.error('DisTube error:', error);
  if (queue?.textChannel) {
    queue.textChannel.send(`⚠️ Audio player error: ${error.message.slice(0, 1900)}`);
  }
});

// Prevent process crashes on unexpected socket or connection errors
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Log in to Discord
client.login(process.env.DISCORD_TOKEN);
