require('dotenv').config();

const {
    Client,
    GatewayIntentBits,
    ChannelType,
    EmbedBuilder,
    PermissionFlagsBits,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Events
} = require('discord.js');
const cloudinary = require('cloudinary').v2;
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const sharp = require('sharp');

// ==========================================
// PREVENT CRASHES ON TIMEOUTS / UNKNOWN INTERACTIONS
// ==========================================
process.on('unhandledRejection', (error) => {
    if (error?.code === 10062) {
        console.warn('Ignored DiscordAPIError[10062]: Unknown interaction.');
        return;
    }
    console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception thrown:', error);
});

// ==========================================
// 1. CREDENTIALS CONFIGURATION (FROM ENVIRONMENT)
// ==========================================
const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

// Cloudinary Configuration
const CLOUD_NAME = process.env.CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

cloudinary.config({
    cloud_name: CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET
});

// Cloudflare R2 & Cache Configuration
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_R2_ACCESS_KEY_ID = process.env.CF_R2_ACCESS_KEY_ID;
const CF_R2_SECRET_ACCESS_KEY = process.env.CF_R2_SECRET_ACCESS_KEY;
const CF_R2_BUCKET_NAME = process.env.CF_R2_BUCKET_NAME || 'artgal-assets';
const CF_PUBLIC_DOMAIN = process.env.CF_PUBLIC_DOMAIN;

// Cloudflare Edge Cache Invalidation (Required)
const CF_ZONE_ID = process.env.CF_ZONE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;

// Validate that required variables are present
const requiredEnvVars = [
    'DISCORD_BOT_TOKEN',
    'CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'CF_ACCOUNT_ID',
    'CF_R2_ACCESS_KEY_ID',
    'CF_R2_SECRET_ACCESS_KEY',
    'CF_PUBLIC_DOMAIN',
    'CF_ZONE_ID',
    'CF_API_TOKEN'
];

for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
        console.error(`FATAL ERROR: Environment variable "${envVar}" is missing.`);
        process.exit(1);
    }
}

// Initialize Cloudflare R2 S3 Client
const r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: CF_R2_ACCESS_KEY_ID,
        secretAccessKey: CF_R2_SECRET_ACCESS_KEY
    }
});

// Initialize Discord Client
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions
    ]
});

// In-memory switches state cache
let switchesState = [
    { id: 1, key: 'Switch1', state: false, description: 'Default description for Switch 1' },
    { id: 2, key: 'Switch2', state: false, description: 'Default description for Switch 2' },
    { id: 3, key: 'Switch3', state: false, description: 'Default description for Switch 3' }
];

// ==========================================
// 2. HELPER FUNCTIONS (SLOTS & STORAGE)
// ==========================================

// Ensures the Content Moderator role exists
async function getOrCreateModeratorRole(guild) {
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === 'content moderator');
    if (!role) {
        role = await guild.roles.create({
            name: 'Content Moderator',
            reason: 'Role required for reviewing slot image submissions'
        });
        console.log(`Created Content Moderator role in ${guild.name}`);
    }
    return role;
}

// Returns the permanent public image URL (Cloudinary)
function getPermanentImageUrl(slotNumber) {
    return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/c_limit,w_2048,h_2048/Slot${slotNumber}.webp`;
}

// Returns the permanent public text URL for the master blurbs file
function getPermanentBlurbsUrl() {
    return `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/Slotblurbs.txt`;
}

// Returns the permanent public text URL for Lights.txt
function getPermanentLightsUrl() {
    return `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/Lights.txt`;
}

// Returns the permanent public URL for the last update record
function getPermanentLastUpdateUrl() {
    return `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/LastUpdate.txt`;
}

// Streams text directly to Cloudinary memory
function uploadTextStream(text, publicId) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                resource_type: 'raw',
                public_id: publicId,
                overwrite: true,
                invalidate: true
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        stream.end(Buffer.from(text, 'utf-8'));
    });
}

// Streams image buffer to Cloudinary
function uploadImageStream(buffer, publicId) {
    return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
            {
                public_id: publicId,
                format: 'webp',
                overwrite: true,
                invalidate: true
            },
            (error, result) => {
                if (error) return reject(error);
                resolve(result);
            }
        );
        stream.end(buffer);
    });
}

// Uploads buffers or strings to Cloudflare R2
async function uploadToR2(body, key, contentType) {
    const command = new PutObjectCommand({
        Bucket: CF_R2_BUCKET_NAME,
        Key: key,
        Body: body,
        ContentType: contentType,
        CacheControl: 'public, max-age=60, must-revalidate'
    });
    return r2Client.send(command);
}

// Instantly purges the Cloudflare CDN edge cache
async function purgeCloudflareUrls(urls) {
    try {
        const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${CF_ZONE_ID}/purge_cache`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${CF_API_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ files: urls })
        });
        const data = await res.json();
        if (!data.success) {
            console.error('Cloudflare Cache Purge Failed:', data.errors);
        } else {
            console.log('Cloudflare Cache Purged Successfully for:', urls);
        }
    } catch (err) {
        console.error('Error contacting Cloudflare Purge API:', err);
    }
}

// ==========================================
// LIGHT SWITCHES LOGIC & SYNCHRONIZATION
// ==========================================

// Formats the switches array to exact Lights.txt syntax
function formatLightsFile(switches) {
    return switches.map(s => `${s.key} = ${s.state}`).join('\n') + '\n';
}

// Uploads Lights.txt and metadata to both Cloudinary and Cloudflare R2
async function syncLightsToStorage(switches) {
    const rawLightsText = formatLightsFile(switches);
    const metaJson = JSON.stringify(switches, null, 2);

    await Promise.all([
        // Cloudinary uploads
        uploadTextStream(rawLightsText, 'Lights.txt'),
        uploadTextStream(metaJson, 'LightsMeta.json'),

        // Cloudflare R2 uploads
        uploadToR2(Buffer.from(rawLightsText, 'utf-8'), 'Lights.txt', 'text/plain; charset=utf-8'),
        uploadToR2(Buffer.from(metaJson, 'utf-8'), 'LightsMeta.json', 'application/json; charset=utf-8')
    ]);

    await purgeCloudflareUrls([
        `${CF_PUBLIC_DOMAIN}/Lights.txt`,
        `${CF_PUBLIC_DOMAIN}/LightsMeta.json`
    ]);
}

// Loads existing switches configuration from Cloudflare R2 / Cloudinary
async function loadSwitchesFromStorage() {
    try {
        const response = await fetch(`${CF_PUBLIC_DOMAIN}/LightsMeta.json?t=${Date.now()}`);
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
                return data;
            }
        }
    } catch (err) {
        // Fallback to reading raw Lights.txt
    }

    try {
        const response = await fetch(`${CF_PUBLIC_DOMAIN}/Lights.txt?t=${Date.now()}`);
        if (response.ok) {
            const raw = await response.text();
            const lines = raw.split('\n').filter(l => l.includes('='));
            if (lines.length > 0) {
                return lines.map((line, idx) => {
                    const [k, v] = line.split('=').map(p => p.trim());
                    return {
                        id: idx + 1,
                        key: k || `Switch${idx + 1}`,
                        state: v.toLowerCase() === 'true',
                        description: `Default description for Switch ${idx + 1}`
                    };
                });
            }
        }
    } catch (err) {
        // Retain default switches
    }

    return switchesState;
}

// Builds the Discord Embed for an individual switch
function buildSwitchEmbed(sw) {
    const stateSquare = sw.state ? '🟩' : '🟥';
    const stateLabel = sw.state ? 'ON' : 'OFF';

    return new EmbedBuilder()
        .setTitle(`${stateSquare} ${sw.key}`)
        .setColor(sw.state ? '#2ecc71' : '#e74c3c')
        .setDescription(sw.description || 'No description provided.')
        .addFields(
            { name: 'State', value: `${stateSquare} ${stateLabel}`, inline: true }
        )
        .setFooter({ text: `Switch ID: ${sw.id}` });
}

// Builds the ON and OFF button ActionRow for a switch
function buildSwitchActionRow(sw) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`light_on_${sw.id}`)
            .setLabel('ON')
            .setStyle(ButtonStyle.Success)
            .setDisabled(sw.state === true),
        new ButtonBuilder()
            .setCustomId(`light_off_${sw.id}`)
            .setLabel('OFF')
            .setStyle(ButtonStyle.Danger)
            .setDisabled(sw.state === false)
    );
}

// Re-renders the entire #light-switches channel
async function renderLightSwitchesChannel(channel, switches) {
    const messages = await channel.messages.fetch({ limit: 100 });
    for (const msg of messages.values()) {
        await msg.delete().catch(() => { });
    }

    for (const sw of switches) {
        await channel.send({
            embeds: [buildSwitchEmbed(sw)],
            components: [buildSwitchActionRow(sw)]
        });
    }
}

// ==========================================
// MASTER BLURBS PARSER & SERIALIZER
// ==========================================

function parseBlurbsFile(rawText) {
    const blurbs = {};
    for (let i = 1; i <= 16; i++) {
        blurbs[i] = 'No description provided.';
    }

    if (!rawText) return blurbs;

    const regex = /===\s*\[SLOT\s*(\d+)\]\s*===/gi;
    const parts = rawText.split(regex);

    for (let i = 1; i < parts.length; i += 2) {
        const slotNum = parseInt(parts[i], 10);
        const text = parts[i + 1] ? parts[i + 1].trim() : '';
        if (slotNum >= 1 && slotNum <= 16) {
            blurbs[slotNum] = text || 'No description provided.';
        }
    }

    return blurbs;
}

function formatBlurbsFile(blurbsMap) {
    const sections = [];
    for (let i = 1; i <= 16; i++) {
        const content = blurbsMap[i] || 'No description provided.';
        sections.push(`=== [SLOT ${i}] ===\n${content}`);
    }
    return sections.join('\n\n') + '\n';
}

async function fetchMasterBlurbsText() {
    try {
        const url = `${getPermanentBlurbsUrl()}?t=${Date.now()}`;
        const response = await fetch(url);
        if (!response.ok) return null;
        return await response.text();
    } catch (err) {
        console.error('Error fetching Slotblurbs.txt:', err);
        return null;
    }
}

async function fetchSingleBlurb(slotNumber) {
    const masterText = await fetchMasterBlurbsText();
    const blurbsMap = parseBlurbsFile(masterText);
    return blurbsMap[slotNumber] || 'No description provided.';
}

async function updateMasterBlurbs(slotNumber, newBlurbContent) {
    const currentText = await fetchMasterBlurbsText();
    const blurbsMap = parseBlurbsFile(currentText);
    blurbsMap[slotNumber] = newBlurbContent;
    return formatBlurbsFile(blurbsMap);
}

function generateLastUpdateContent(slotNumber, blurbContent) {
    const timestamp = new Date().toISOString();
    const unixTimestamp = Math.floor(Date.now() / 1000);

    return [
        `LastUpdate: ${timestamp}`,
        `UnixTimestamp: ${unixTimestamp}`,
        `Slot: ${slotNumber}`,
        `ImageUrl: ${getPermanentImageUrl(slotNumber)}`,
        `R2ImageUrl: ${CF_PUBLIC_DOMAIN}/Slot${slotNumber}.webp`,
        `MasterTextUrl: ${getPermanentBlurbsUrl()}`,
        `R2MasterTextUrl: ${CF_PUBLIC_DOMAIN}/Slotblurbs.txt`,
        `Blurb: ${blurbContent}`
    ].join('\n');
}

function buildPreviewEmbed(slotNumber, version = null, blurbText = 'No text loaded.') {
    const permImageUrl = getPermanentImageUrl(slotNumber);
    const masterTextUrl = getPermanentBlurbsUrl();

    const versionSegment = version ? `v${version}/` : '';
    const displayUrl = `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${versionSegment}c_limit,w_2048,h_2048/Slot${slotNumber}.webp`;

    return new EmbedBuilder()
        .setTitle(`Slot #${slotNumber}`)
        .setColor('#0099ff')
        .setDescription(
            `**Image URL (Cloudinary):**\n<${permImageUrl}>\n\n` +
            `**Image URL (R2):**\n<${CF_PUBLIC_DOMAIN}/Slot${slotNumber}.webp>\n\n` +
            `**Master Text (Slotblurbs.txt):**\n<${masterTextUrl}>\n\n` +
            `Attach an image and type a message to update both simultaneously.`
        )
        .addFields({
            name: `Live Blurb for Slot #${slotNumber}`,
            value: blurbText.length > 1024 ? blurbText.slice(0, 1020) + '...' : blurbText
        })
        .setImage(displayUrl)
        .setFooter({ text: 'One-time access: uploading revokes access' })
        .setTimestamp();
}

async function renderSlotChannel(channel, slotNumber) {
    const messages = await channel.messages.fetch({ limit: 50 });
    for (const msg of messages.values()) {
        await msg.delete().catch(() => { });
    }
    const currentBlurb = await fetchSingleBlurb(slotNumber);
    await channel.send({ embeds: [buildPreviewEmbed(slotNumber, null, currentBlurb)] });
}

// ==========================================
// CHANNEL INITIALIZATION & SYNCHRONIZATION
// ==========================================

async function setupChannels(guild) {
    console.log(`Setting up channels for guild: ${guild.name}...`);
    await getOrCreateModeratorRole(guild);

    const basePermissions = [
        {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
        },
        {
            id: client.user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageMessages,
                PermissionFlagsBits.EmbedLinks,
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.AddReactions,
                PermissionFlagsBits.ReadMessageHistory
            ]
        }
    ];

    let category = guild.channels.cache.find(
        c => c.name.toLowerCase() === 'image slots' && c.type === ChannelType.GuildCategory
    );

    if (!category) {
        category = await guild.channels.create({
            name: 'IMAGE SLOTS',
            type: ChannelType.GuildCategory,
            permissionOverwrites: basePermissions
        });
    }

    // Initialize 16 Image Slot channels
    for (let i = 1; i <= 16; i++) {
        const channelName = `slot-${i}`;
        let channel = guild.channels.cache.find(
            c => c.name === channelName && c.parentId === category.id
        );

        if (!channel) {
            channel = await guild.channels.create({
                name: channelName,
                type: ChannelType.GuildText,
                parent: category.id,
                permissionOverwrites: basePermissions,
                topic: `Upload an image + caption here to update Slot #${i}`
            });
            console.log(`Created private channel #${channelName}`);
        }

        const messages = await channel.messages.fetch({ limit: 10 });
        const botMessage = messages.find(m => m.author.id === client.user.id);

        if (!botMessage) {
            const currentBlurb = await fetchSingleBlurb(i);
            await channel.send({ embeds: [buildPreviewEmbed(i, null, currentBlurb)] });
        }
    }

    // Initialize #light-switches channel
    let lightsChannel = guild.channels.cache.find(
        c => c.name === 'light-switches' && c.parentId === category.id
    );

    if (!lightsChannel) {
        lightsChannel = await guild.channels.create({
            name: 'light-switches',
            type: ChannelType.GuildText,
            parent: category.id,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
                    deny: [PermissionFlagsBits.SendMessages]
                },
                {
                    id: client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ManageMessages,
                        PermissionFlagsBits.EmbedLinks
                    ]
                }
            ],
            topic: 'Controls for Lights.txt switches'
        });
        console.log('Created #light-switches channel');
    }

    await renderLightSwitchesChannel(lightsChannel, switchesState);
    console.log('Channels and switches are synced.');
}

// ==========================================
// 3. EVENT LISTENERS
// ==========================================

client.on(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}!`);
    switchesState = await loadSwitchesFromStorage();
    await syncLightsToStorage(switchesState);

    for (const guild of client.guilds.cache.values()) {
        try {
            await setupChannels(guild);
        } catch (err) {
            console.error(`Setup error on ${guild.name}:`, err);
        }
    }
});

// Listener: Embedded Button Interactions for Light Switches
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const { customId } = interaction;
    if (!customId.startsWith('light_on_') && !customId.startsWith('light_off_')) return;

    const isTurningOn = customId.startsWith('light_on_');
    const switchId = parseInt(customId.replace(isTurningOn ? 'light_on_' : 'light_off_', ''), 10);

    const sw = switchesState.find(s => s.id === switchId);
    if (!sw) {
        return interaction.reply({ content: 'Switch not found.', ephemeral: true });
    }

    try {
        await interaction.deferUpdate();

        sw.state = isTurningOn;
        await syncLightsToStorage(switchesState);

        await interaction.editReply({
            embeds: [buildSwitchEmbed(sw)],
            components: [buildSwitchActionRow(sw)]
        });
    } catch (err) {
        if (err?.code === 10062) {
            console.warn(`Interaction timed out or acknowledged elsewhere for Switch #${switchId}`);
            return;
        }
        console.error('Error handling button interaction:', err);
    }
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // ----------------------------------------------------
    // COMMAND: !addswitch [optional description]
    // ----------------------------------------------------
    if (message.content.startsWith('!addswitch')) {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return message.reply('Only administrators can add switches.');
        }

        const args = message.content.split(' ').slice(1);
        const customDesc = args.join(' ').trim();

        const nextId = switchesState.length > 0 ? Math.max(...switchesState.map(s => s.id)) + 1 : 1;
        const newKey = `Switch${nextId}`;
        const newSwitch = {
            id: nextId,
            key: newKey,
            state: false,
            description: customDesc || `Default description for ${newKey}`
        };

        switchesState.push(newSwitch);
        await syncLightsToStorage(switchesState);

        const lightsChannel = message.guild.channels.cache.find(c => c.name === 'light-switches');
        if (lightsChannel) {
            await renderLightSwitchesChannel(lightsChannel, switchesState);
        }

        return message.reply(`Added ${newKey} (default: OFF).`);
    }

    // ----------------------------------------------------
    // COMMAND: !setswitchdesc <SwitchNumber/Name> <description>
    // ----------------------------------------------------
    if (message.content.startsWith('!setswitchdesc') || message.content.startsWith('!switchdesc')) {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return message.reply('Only administrators can modify switch descriptions.');
        }

        const parts = message.content.trim().split(/\s+/);
        if (parts.length < 3) {
            return message.reply('Usage: `!setswitchdesc <switch number or name> <new description>`\nExample: `!setswitchdesc 2 Kitchen Lights`');
        }

        const targetIdentifier = parts[1].toLowerCase().replace('switch', '');
        const targetId = parseInt(targetIdentifier, 10);
        const newDescription = parts.slice(2).join(' ');

        const targetSwitch = switchesState.find(s => s.id === targetId || s.key.toLowerCase() === parts[1].toLowerCase());
        if (!targetSwitch) {
            return message.reply(`Switch not found for query "${parts[1]}".`);
        }

        targetSwitch.description = newDescription;
        await syncLightsToStorage(switchesState);

        const lightsChannel = message.guild.channels.cache.find(c => c.name === 'light-switches');
        if (lightsChannel) {
            await renderLightSwitchesChannel(lightsChannel, switchesState);
        }

        return message.reply(`Updated description for ${targetSwitch.key}.`);
    }

    // ----------------------------------------------------
    // COMMAND: !grant @User <SlotNumber>
    // ----------------------------------------------------
    if (message.content.startsWith('!grant')) {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return message.reply('Only administrators can grant access.');
        }

        const targetMember = message.mentions.members.first();
        const args = message.content.split(' ');
        const slotArg = args.find(arg => !isNaN(arg) && arg.trim() !== '');
        const slotNumber = parseInt(slotArg, 10);

        if (!targetMember || isNaN(slotNumber) || slotNumber < 1 || slotNumber > 16) {
            return message.reply('Usage: `!grant @user <1-16>`\nExample: `!grant @Alex 4`');
        }

        const channelName = `slot-${slotNumber}`;
        const targetChannel = message.guild.channels.cache.find(c => c.name === channelName);

        if (!targetChannel) {
            return message.reply(`Could not find channel #${channelName}.`);
        }

        await targetChannel.permissionOverwrites.edit(targetMember.id, {
            ViewChannel: true,
            SendMessages: true,
            AttachFiles: true
        });

        message.reply(`Granted **${targetMember.displayName}** one-time access to **#${channelName}**.`);
        targetMember.send(`You have been given temporary access to **#${channelName}**. Drop your image and blurb text there.`).catch(() => { });
        return;
    }

    // ----------------------------------------------------
    // LISTENER: Image upload + Text in slot channels
    // ----------------------------------------------------
    const match = message.channel.name.match(/^slot-([1-9]|1[0-6])$/);
    if (!match) return;

    const modRole = await getOrCreateModeratorRole(message.guild);
    const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
    const isMod = message.member.roles.cache.has(modRole.id);

    if (isMod && !isAdmin) {
        return;
    }

    const slotNumber = parseInt(match[1], 10);
    const attachment = message.attachments.first();

    if (!attachment || !attachment.contentType?.startsWith('image/')) {
        setTimeout(() => message.delete().catch(() => { }), 3000);
        const warning = await message.channel.send('Please attach an image file (with optional blurb text in the caption).');
        setTimeout(() => warning.delete().catch(() => { }), 3000);
        return;
    }

    const blurbContent = message.content.trim() || 'No description provided.';
    const submitter = message.author;

    try {
        const response = await fetch(attachment.url);
        const arrayBuffer = await response.arrayBuffer();
        const rawBuffer = Buffer.from(arrayBuffer);

        if (!isAdmin) {
            await message.channel.permissionOverwrites.delete(submitter.id).catch(() => { });
            submitter.send(`Your submission for Slot #${slotNumber} has been received and is waiting for moderator approval.`).catch(() => { });
        }

        await message.channel.permissionOverwrites.edit(modRole.id, {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: true,
            AddReactions: true
        });

        const approvalEmbed = new EmbedBuilder()
            .setTitle(`Review Required: Slot #${slotNumber}`)
            .setColor('#f1c40f')
            .setDescription(`**Submitted By:** ${submitter.tag} (<@${submitter.id}>)\n\n**Proposed Blurb:**\n${blurbContent}`)
            .setImage(attachment.url)
            .setFooter({ text: 'React with ✅ to approve or ❌ to reject.' })
            .setTimestamp();

        const modPrompt = await message.channel.send({
            content: `<@&${modRole.id}> A new image has been submitted for **Slot #${slotNumber}**. Please review and react below:`,
            embeds: [approvalEmbed]
        });

        await modPrompt.react('✅');
        await modPrompt.react('❌');

        const collector = modPrompt.createReactionCollector({
            filter: (reaction, user) => ['✅', '❌'].includes(reaction.emoji.name) && !user.bot,
            time: 86400000 // 24 hours
        });

        collector.on('collect', async (reaction, user) => {
            const member = await message.guild.members.fetch(user.id).catch(() => null);
            if (!member) return;

            const isAuthorized = member.roles.cache.has(modRole.id) || member.permissions.has(PermissionFlagsBits.Administrator);
            if (!isAuthorized) {
                await reaction.users.remove(user.id).catch(() => { });
                return;
            }

            collector.stop('handled');

            await message.delete().catch(() => { });
            await message.channel.permissionOverwrites.delete(modRole.id).catch(() => { });

            if (reaction.emoji.name === '✅') {
                const statusMsg = await message.channel.send(`Approved by ${user.tag}. Converting to WebP and updating Slotblurbs.txt...`);

                const webpBuffer = await sharp(rawBuffer)
                    .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true })
                    .webp({ quality: 95 })
                    .toBuffer();

                const imageFileName = `Slot${slotNumber}.webp`;

                const updatedMasterBlurbs = await updateMasterBlurbs(slotNumber, blurbContent);
                const lastUpdateContent = generateLastUpdateContent(slotNumber, blurbContent);

                const [cloudinaryImageResult] = await Promise.all([
                    uploadImageStream(webpBuffer, `Slot${slotNumber}`),
                    uploadTextStream(updatedMasterBlurbs, 'Slotblurbs.txt'),
                    uploadTextStream(lastUpdateContent, 'LastUpdate.txt'),

                    uploadToR2(webpBuffer, imageFileName, 'image/webp'),
                    uploadToR2(Buffer.from(updatedMasterBlurbs, 'utf-8'), 'Slotblurbs.txt', 'text/plain; charset=utf-8'),
                    uploadToR2(Buffer.from(lastUpdateContent, 'utf-8'), 'LastUpdate.txt', 'text/plain; charset=utf-8')
                ]);

                await purgeCloudflareUrls([
                    `${CF_PUBLIC_DOMAIN}/${imageFileName}`,
                    `${CF_PUBLIC_DOMAIN}/Slotblurbs.txt`,
                    `${CF_PUBLIC_DOMAIN}/LastUpdate.txt`
                ]);

                await statusMsg.edit('Uploaded. Waiting 30 seconds for Cloudinary CDN propagation...');
                await new Promise(resolve => setTimeout(resolve, 30000));

                const currentSlotBlurb = await fetchSingleBlurb(slotNumber);

                const msgs = await message.channel.messages.fetch({ limit: 15 });
                for (const msg of msgs.values()) {
                    await msg.delete().catch(() => { });
                }

                await message.channel.send({
                    embeds: [buildPreviewEmbed(slotNumber, cloudinaryImageResult.version, currentSlotBlurb)]
                });

                submitter.send(`Your submission for Slot #${slotNumber} was approved and is now live on both Cloudinary and R2.`).catch(() => { });

            } else if (reaction.emoji.name === '❌') {
                await message.channel.send(`Submission rejected by ${user.tag}. Resetting channel view...`);
                submitter.send(`Your submission for Slot #${slotNumber} was rejected by a moderator.`).catch(() => { });

                await new Promise(resolve => setTimeout(resolve, 3000));
                await renderSlotChannel(message.channel, slotNumber);
            }
        });

        collector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                await message.delete().catch(() => { });
                await message.channel.permissionOverwrites.delete(modRole.id).catch(() => { });
                await message.channel.send(`Review for Slot #${slotNumber} timed out without a decision.`);
                await renderSlotChannel(message.channel, slotNumber);
            }
        });

    } catch (err) {
        console.error('Upload Error:', err);
        const errorMessage = err?.message || err?.error?.message || JSON.stringify(err);
        await message.channel.send(`Error handling upload: ${errorMessage}`);
    }
});

client.login(DISCORD_BOT_TOKEN);