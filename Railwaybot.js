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
    Events,
    Partials
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

// Cloudflare R2 & Domain Configuration
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_R2_ACCESS_KEY_ID = process.env.CF_R2_ACCESS_KEY_ID;
const CF_R2_SECRET_ACCESS_KEY = process.env.CF_R2_SECRET_ACCESS_KEY;
const CF_R2_BUCKET_NAME = process.env.CF_R2_BUCKET_NAME || 'artgal-assets';
const CF_PUBLIC_DOMAIN = process.env.CF_PUBLIC_DOMAIN;

// Cloudflare Edge Cache Invalidation (Inactive / Optional for now)
const CF_ZONE_ID = process.env.CF_ZONE_ID || null;
const CF_API_TOKEN = process.env.CF_API_TOKEN || null;

// Sightengine AI Moderation Configuration
const SIGHTENGINE_API_USER = process.env.SIGHTENGINE_API_USER;
const SIGHTENGINE_API_SECRET = process.env.SIGHTENGINE_API_SECRET;
const SIGHTENGINE_MODELS = process.env.SIGHTENGINE_MODELS || 'genai';

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
    'SIGHTENGINE_API_USER',
    'SIGHTENGINE_API_SECRET'
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
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// Cooldown and Scan Trackers
const submissionCooldowns = new Map();
const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const scannedAiSubmissions = new Set();

// In-memory switches state cache
let switchesState = [
    { id: 1, key: 'Switch1', state: false, description: 'Default description for Switch 1' },
    { id: 2, key: 'Switch2', state: false, description: 'Default description for Switch 2' },
    { id: 3, key: 'Switch3', state: false, description: 'Default description for Switch 3' }
];

// Group Configuration for Slots
const SLOT_GROUPS = [
    { name: 'Group A', slots: [7, 3, 11, 13] },
    { name: 'Group B', slots: [5, 6, 16, 15] },
    { name: 'Group C', slots: [9, 8, 14, 12] },
    { name: 'Group D', slots: [1, 2, 4, 10] }
];

// Number Emoji Mapping
const NUMBER_EMOJIS = {
    '0': '0️⃣',
    '1': '1️⃣',
    '2': '2️⃣',
    '3': '3️⃣',
    '4': '4️⃣',
    '5': '5️⃣',
    '6': '6️⃣',
    '7': '7️⃣',
    '8': '8️⃣',
    '9': '9️⃣'
};

// ==========================================
// 2. HELPER FUNCTIONS (SLOTS & STORAGE)
// ==========================================

function getNextGroupChangeInfo() {
    // Starting Sunday, November 15, 2026 UTC
    const startDate = new Date(Date.UTC(2026, 10, 15, 0, 0, 0));
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const groupOrder = ['Group D', 'Group C', 'Group B', 'Group A'];
    const now = new Date();

    if (now.getTime() < startDate.getTime()) {
        return {
            date: startDate,
            group: 'Group D'
        };
    }

    const diff = now.getTime() - startDate.getTime();
    const cycleIndex = Math.floor(diff / weekMs) + 1;
    const nextDate = new Date(startDate.getTime() + cycleIndex * weekMs);
    const nextGroup = groupOrder[cycleIndex % groupOrder.length];

    return {
        date: nextDate,
        group: nextGroup
    };
}

async function syncNextChangeVoiceChannel(guild, automationCategory) {
    const info = getNextGroupChangeInfo();
    const dateStr = info.date.toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        timeZone: 'UTC'
    });
    const desiredChannelName = `📅 ${dateStr} - ${info.group}`;

    let vc = guild.channels.cache.find(
        c => c.parentId === automationCategory.id && c.type === ChannelType.GuildVoice
    );

    const lockedPermissions = [
        {
            id: guild.roles.everyone.id,
            allow: [PermissionFlagsBits.ViewChannel],
            deny: [PermissionFlagsBits.Connect]
        },
        {
            id: client.user.id,
            allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.Connect
            ]
        }
    ];

    if (!vc) {
        vc = await guild.channels.create({
            name: desiredChannelName,
            type: ChannelType.GuildVoice,
            parent: automationCategory.id,
            permissionOverwrites: lockedPermissions
        });
        console.log(`Created locked next-change voice channel: ${desiredChannelName}`);
    } else {
        if (vc.name !== desiredChannelName) {
            await vc.setName(desiredChannelName).catch(() => { });
            console.log(`Updated next-change voice channel to: ${desiredChannelName}`);
        }
    }
}

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

async function getOrCreateVotersRole(guild) {
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === 'voters');
    if (!role) {
        role = await guild.roles.create({
            name: 'Voters',
            reason: 'Role required for viewing submission history and voting'
        });
        console.log(`Created Voters role in ${guild.name}`);
    }
    return role;
}

async function getOrCreateBlindRole(guild) {
    let role = guild.roles.cache.find(r => r.name.toLowerCase() === 'blind');
    if (!role) {
        role = await guild.roles.create({
            name: 'Blind',
            color: '#34495e',
            reason: 'Role restricted from posting attachments, links, and accessing submissions'
        });
        console.log(`Created Blind role in ${guild.name}`);
    }
    return role;
}

async function applyBlindRole(member, guild) {
    const blindRole = await getOrCreateBlindRole(guild);
    await member.roles.add(blindRole).catch(() => { });

    for (const channel of guild.channels.cache.values()) {
        if (channel.name === 'submissions') {
            await channel.permissionOverwrites.edit(blindRole.id, {
                ViewChannel: false,
                AttachFiles: false,
                EmbedLinks: false
            }).catch(() => { });
        } else if (channel.type === ChannelType.GuildCategory || channel.isTextBased()) {
            await channel.permissionOverwrites.edit(blindRole.id, {
                AttachFiles: false,
                EmbedLinks: false
            }).catch(() => { });
        }
    }
}

function getPermanentImageUrl(slotNumber) {
    return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/c_limit,w_2048,h_2048/Slot${slotNumber}.webp`;
}

function getPermanentBlurbsUrl() {
    return `https://res.cloudinary.com/${CLOUD_NAME}/raw/upload/Slotblurbs.txt`;
}

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

async function purgeCloudflareUrls(urls) {
    if (!CF_ZONE_ID || !CF_API_TOKEN) {
        return;
    }

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

async function querySightengine(imageUrl) {
    const endpoint = new URL('https://api.sightengine.com/1.0/check.json');
    endpoint.searchParams.append('models', SIGHTENGINE_MODELS);
    endpoint.searchParams.append('api_user', SIGHTENGINE_API_USER);
    endpoint.searchParams.append('api_secret', SIGHTENGINE_API_SECRET);
    endpoint.searchParams.append('url', imageUrl);

    const response = await fetch(endpoint.toString());
    return await response.json();
}

async function fetchSlotImageBuffer(slotNumber) {
    const candidates = [
        `${CF_PUBLIC_DOMAIN}/Slot${slotNumber}.webp?t=${Date.now()}`,
        `${getPermanentImageUrl(slotNumber)}?t=${Date.now()}`
    ];

    for (const url of candidates) {
        try {
            const res = await fetch(url);
            if (res.ok) {
                const arrayBuffer = await res.arrayBuffer();
                return Buffer.from(arrayBuffer);
            }
        } catch (err) { }
    }
    throw new Error(`Unable to fetch existing image for Slot #${slotNumber}`);
}

// ==========================================
// LIGHT SWITCHES LOGIC & SYNCHRONIZATION
// ==========================================

function formatLightsFile(switches) {
    return switches.map(s => `${s.key} = ${s.state}`).join('\n') + '\n';
}

async function syncLightsToStorage(switches) {
    const rawLightsText = formatLightsFile(switches);
    const metaJson = JSON.stringify(switches, null, 2);

    await Promise.all([
        uploadTextStream(rawLightsText, 'Lights.txt'),
        uploadTextStream(metaJson, 'LightsMeta.json'),

        uploadToR2(Buffer.from(rawLightsText, 'utf-8'), 'Lights.txt', 'text/plain; charset=utf-8'),
        uploadToR2(Buffer.from(metaJson, 'utf-8'), 'LightsMeta.json', 'application/json; charset=utf-8')
    ]);

    await purgeCloudflareUrls([
        `${CF_PUBLIC_DOMAIN}/Lights.txt`,
        `${CF_PUBLIC_DOMAIN}/LightsMeta.json`
    ]);
}

async function loadSwitchesFromStorage() {
    try {
        const response = await fetch(`${CF_PUBLIC_DOMAIN}/LightsMeta.json?t=${Date.now()}`);
        if (response.ok) {
            const data = await response.json();
            if (Array.isArray(data) && data.length > 0) {
                return data;
            }
        }
    } catch (err) { }

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
    } catch (err) { }

    return switchesState;
}

function buildSwitchEmbed(sw) {
    const stateSquare = sw.state ? '🟩' : '🟥';
    const stateLabel = sw.state ? 'ON' : 'OFF';

    return new EmbedBuilder()
        .setTitle(`${stateSquare} ${sw.key}`)
        .setColor(sw.state ? '#2ecc71' : '#e74c3c')
        .setDescription(sw.description || 'No description provided.')
        .addFields({ name: 'State', value: `${stateSquare} ${stateLabel}`, inline: true })
        .setFooter({ text: `Switch ID: ${sw.id}` });
}

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
            `Attach an image and type a message to update both simultaneously.\n` +
            `画像ファイルを添付し、メッセージを入力して同時に更新してください。`
        )
        .addFields({
            name: `Live Blurb for Slot #${slotNumber} / 説明文`,
            value: blurbText.length > 1024 ? blurbText.slice(0, 1020) + '...' : blurbText
        })
        .setImage(displayUrl)
        .setFooter({ text: 'Access is retained until accepted. / 承認されるまでアクセス権は保持されます。' })
        .setTimestamp();
}

async function renderSlotChannel(channel, slotNumber, version = null) {
    const messages = await channel.messages.fetch({ limit: 50 });
    for (const msg of messages.values()) {
        await msg.delete().catch(() => { });
    }
    const currentBlurb = await fetchSingleBlurb(slotNumber);
    await channel.send({ embeds: [buildPreviewEmbed(slotNumber, version, currentBlurb)] });
}

// ==========================================
// UNIFIED PIPELINE FOR DEPLOYING SLOT UPDATES
// ==========================================

async function deploySlotUpdate({
    guild,
    slotNumber,
    rawImageBuffer,
    blurbContent,
    submitter,
    approverUser,
    feedbackChannel,
    submissionMessage = null,
    commandMessage = null
}) {
    const isSubmissionsChannel = feedbackChannel.name === 'submissions';

    const statusMsg = await feedbackChannel.send(
        `Approved by ${approverUser.tag}. Converting to WebP and updating slot #${slotNumber}...\n` +
        `${approverUser.tag} によって承認されました。WebPへの変換とスロット #${slotNumber} を更新中...`
    );

    const webpBuffer = await sharp(rawImageBuffer)
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

    await statusMsg.edit(
        'Uploaded. Waiting 30 seconds for Cloudinary CDN propagation...\n' +
        'アップロード完了。CDNの反映を30秒間待機しています...'
    );
    await new Promise(resolve => setTimeout(resolve, 30000));

    const currentSlotBlurb = await fetchSingleBlurb(slotNumber);

    const targetSlotChannel = guild.channels.cache.find(c => c.name === `slot-${slotNumber}`);
    if (targetSlotChannel) {
        const msgs = await targetSlotChannel.messages.fetch({ limit: 15 });
        for (const msg of msgs.values()) {
            await msg.delete().catch(() => { });
        }

        await targetSlotChannel.send({
            embeds: [buildPreviewEmbed(slotNumber, cloudinaryImageResult.version, currentSlotBlurb)]
        });

        await targetSlotChannel.permissionOverwrites.delete(submitter.id).catch(() => { });
        await targetSlotChannel.send(
            `<@${submitter.id}> Your submission for **Slot #${slotNumber}** was accepted and is live.\n` +
            `スロット #${slotNumber} への投稿が承認され、公開されました。`
        );
    }

    if (submissionMessage) {
        await submissionMessage.delete().catch(() => { });
    }
    if (commandMessage) {
        await commandMessage.delete().catch(() => { });
    }

    if (isSubmissionsChannel) {
        await statusMsg.edit(
            `Slot #${slotNumber} is now live with submission by <@${submitter.id}>.\n` +
            `スロット #${slotNumber} に <@${submitter.id}> の作品が公開されました。 (Cleaning up...)`
        );
        setTimeout(() => {
            statusMsg.delete().catch(() => { });
        }, 8000);
    } else {
        await statusMsg.edit(
            `Slot #${slotNumber} is now live with submission by <@${submitter.id}>.\n` +
            `スロット #${slotNumber} に <@${submitter.id}> の作品が公開されました。`
        );
    }
}

// ==========================================
// PIPELINE FOR SWAPPING TWO SLOTS
// ==========================================

async function swapSlots({ guild, slot1, slot2, feedbackChannel, operatorUser }) {
    const statusMsg = await feedbackChannel.send(
        `Initiating swap between Slot #${slot1} and Slot #${slot2} by ${operatorUser.tag}...\n` +
        `${operatorUser.tag} によるスロット #${slot1} と #${slot2} の入れ替えを開始しています...`
    );

    try {
        const [buffer1, buffer2, masterText] = await Promise.all([
            fetchSlotImageBuffer(slot1),
            fetchSlotImageBuffer(slot2),
            fetchMasterBlurbsText()
        ]);

        const blurbsMap = parseBlurbsFile(masterText);
        const blurb1 = blurbsMap[slot1] || 'No description provided.';
        const blurb2 = blurbsMap[slot2] || 'No description provided.';

        blurbsMap[slot1] = blurb2;
        blurbsMap[slot2] = blurb1;
        const updatedMasterBlurbs = formatBlurbsFile(blurbsMap);

        const lastUpdateContent = [
            `LastUpdate: ${new Date().toISOString()}`,
            `UnixTimestamp: ${Math.floor(Date.now() / 1000)}`,
            `Action: Swapped Slot ${slot1} and Slot ${slot2}`,
            `MasterTextUrl: ${getPermanentBlurbsUrl()}`,
            `R2MasterTextUrl: ${CF_PUBLIC_DOMAIN}/Slotblurbs.txt`
        ].join('\n');

        await statusMsg.edit('Uploading swapped assets to Cloudinary & Cloudflare R2...\nストレージへ反映中...');

        const [cldRes1, cldRes2] = await Promise.all([
            uploadImageStream(buffer2, `Slot${slot1}`),
            uploadImageStream(buffer1, `Slot${slot2}`),
            uploadTextStream(updatedMasterBlurbs, 'Slotblurbs.txt'),
            uploadTextStream(lastUpdateContent, 'LastUpdate.txt'),

            uploadToR2(buffer2, `Slot${slot1}.webp`, 'image/webp'),
            uploadToR2(buffer1, `Slot${slot2}.webp`, 'image/webp'),
            uploadToR2(Buffer.from(updatedMasterBlurbs, 'utf-8'), 'Slotblurbs.txt', 'text/plain; charset=utf-8'),
            uploadToR2(Buffer.from(lastUpdateContent, 'utf-8'), 'LastUpdate.txt', 'text/plain; charset=utf-8')
        ]);

        await purgeCloudflareUrls([
            `${CF_PUBLIC_DOMAIN}/Slot${slot1}.webp`,
            `${CF_PUBLIC_DOMAIN}/Slot${slot2}.webp`,
            `${CF_PUBLIC_DOMAIN}/Slotblurbs.txt`,
            `${CF_PUBLIC_DOMAIN}/LastUpdate.txt`
        ]);

        await statusMsg.edit('Uploaded. Waiting 20 seconds for CDN cache propagation...\nCDNの反映を20秒間待機しています...');
        await new Promise(resolve => setTimeout(resolve, 20000));

        const channel1 = guild.channels.cache.find(c => c.name === `slot-${slot1}`);
        const channel2 = guild.channels.cache.find(c => c.name === `slot-${slot2}`);

        if (channel1) {
            await renderSlotChannel(channel1, slot1, cldRes1.version);
        }
        if (channel2) {
            await renderSlotChannel(channel2, slot2, cldRes2.version);
        }

        await statusMsg.edit(
            `Successfully swapped Slot #${slot1} and Slot #${slot2}.\n` +
            `スロット #${slot1} とスロット #${slot2} の入れ替えが完了しました。`
        );
    } catch (err) {
        console.error('Error swapping slots:', err);
        await statusMsg.edit(`Failed to swap slots: ${err.message || err}`);
    }
}

// ==========================================
// CHANNEL INITIALIZATION & SYNCHRONIZATION
// ==========================================

async function setupChannels(guild) {
    console.log(`Setting up channels for guild: ${guild.name}...`);
    const modRole = await getOrCreateModeratorRole(guild);
    const votersRole = await getOrCreateVotersRole(guild);
    const blindRole = await getOrCreateBlindRole(guild);

    const basePermissions = [
        {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.ViewChannel]
        },
        {
            id: blindRole.id,
            deny: [
                PermissionFlagsBits.AttachFiles,
                PermissionFlagsBits.EmbedLinks
            ]
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

    const legacyCategory = guild.channels.cache.find(
        c => c.name.toLowerCase() === 'image slots' && c.type === ChannelType.GuildCategory
    );

    // --- Category: AUTOMATION ---
    let automationCategory = guild.channels.cache.find(
        c => c.name.toLowerCase() === 'automation' && c.type === ChannelType.GuildCategory
    );

    if (!automationCategory) {
        automationCategory = await guild.channels.create({
            name: 'AUTOMATION',
            type: ChannelType.GuildCategory,
            permissionOverwrites: basePermissions
        });
    }

    // --- Sync Next Group Change Locked Voice Channel (under AUTOMATION) ---
    await syncNextChangeVoiceChannel(guild, automationCategory);

    // --- Submissions Channel Setup (under AUTOMATION) ---
    let submissionsChannel = guild.channels.cache.find(c => c.name === 'submissions');
    if (!submissionsChannel) {
        submissionsChannel = await guild.channels.create({
            name: 'submissions',
            type: ChannelType.GuildText,
            parent: automationCategory.id,
            rateLimitPerUser: 21600,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.AttachFiles
                    ],
                    deny: [
                        PermissionFlagsBits.ReadMessageHistory
                    ]
                },
                {
                    id: blindRole.id,
                    deny: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks
                    ]
                },
                {
                    id: modRole.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.AddReactions
                    ]
                },
                {
                    id: votersRole.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AddReactions
                    ]
                },
                {
                    id: client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ManageMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AddReactions
                    ]
                }
            ],
            topic: 'Submit an image and exactly 3 lines of text.'
        });
        console.log('Created #submissions channel in AUTOMATION');
    } else if (submissionsChannel.parentId !== automationCategory.id) {
        await submissionsChannel.setParent(automationCategory.id, { lockPermissions: false });
    }

    await submissionsChannel.permissionOverwrites.edit(blindRole.id, {
        ViewChannel: false,
        AttachFiles: false,
        EmbedLinks: false
    }).catch(() => { });

    // --- Light Switches Channel Setup (under AUTOMATION) ---
    let lightsChannel = guild.channels.cache.find(c => c.name === 'light-switches');
    if (!lightsChannel) {
        lightsChannel = await guild.channels.create({
            name: 'light-switches',
            type: ChannelType.GuildText,
            parent: automationCategory.id,
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
        console.log('Created #light-switches channel in AUTOMATION');
    } else if (lightsChannel.parentId !== automationCategory.id) {
        await lightsChannel.setParent(automationCategory.id, { lockPermissions: false });
    }

    // --- AI Logs Channel Setup (under AUTOMATION) ---
    let aiLogsChannel = guild.channels.cache.find(c => c.name === 'ai-logs');
    if (!aiLogsChannel) {
        aiLogsChannel = await guild.channels.create({
            name: 'ai-logs',
            type: ChannelType.GuildText,
            parent: automationCategory.id,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: modRole.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.ReadMessageHistory
                    ]
                },
                {
                    id: client.user.id,
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.AttachFiles,
                        PermissionFlagsBits.EmbedLinks,
                        PermissionFlagsBits.ReadMessageHistory
                    ]
                }
            ],
            topic: 'Logs for Sightengine AI image analysis.'
        });
        console.log('Created #ai-logs channel in AUTOMATION');
    } else if (aiLogsChannel.parentId !== automationCategory.id) {
        await aiLogsChannel.setParent(automationCategory.id, { lockPermissions: false });
    }

    // --- Groups A, B, C, D Category and Slot Setup ---
    for (const group of SLOT_GROUPS) {
        let category = guild.channels.cache.find(
            c => c.name.toLowerCase() === group.name.toLowerCase() && c.type === ChannelType.GuildCategory
        );

        if (!category) {
            category = await guild.channels.create({
                name: group.name,
                type: ChannelType.GuildCategory,
                permissionOverwrites: basePermissions
            });
            console.log(`Created category ${group.name}`);
        } else {
            await category.permissionOverwrites.edit(blindRole.id, {
                AttachFiles: false,
                EmbedLinks: false
            }).catch(() => { });
        }

        for (const slotNum of group.slots) {
            const channelName = `slot-${slotNum}`;
            let channel = guild.channels.cache.find(c => c.name === channelName);

            if (!channel) {
                channel = await guild.channels.create({
                    name: channelName,
                    type: ChannelType.GuildText,
                    parent: category.id,
                    permissionOverwrites: basePermissions,
                    topic: `Upload an image + caption here to update Slot #${slotNum}`
                });
                console.log(`Created private channel #${channelName} under ${group.name}`);
            } else if (channel.parentId !== category.id) {
                await channel.setParent(category.id, { lockPermissions: false });
                console.log(`Moved #${channelName} under ${group.name}`);
            }

            const messages = await channel.messages.fetch({ limit: 10 }).catch(() => null);
            const botMessage = messages ? messages.find(m => m.author.id === client.user.id) : null;

            if (!botMessage) {
                const currentBlurb = await fetchSingleBlurb(slotNum);
                await channel.send({ embeds: [buildPreviewEmbed(slotNum, null, currentBlurb)] });
            }
        }
    }

    if (legacyCategory) {
        const hasChildren = guild.channels.cache.some(c => c.parentId === legacyCategory.id);
        if (!hasChildren) {
            await legacyCategory.delete().catch(() => { });
            console.log('Removed empty legacy IMAGE SLOTS category.');
        }
    }

    await renderLightSwitchesChannel(lightsChannel, switchesState);
    console.log('Channels, categories, roles, and switches are synced.');
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

    // Periodic check every 30 minutes to roll over the locked voice channel name
    setInterval(async () => {
        for (const guild of client.guilds.cache.values()) {
            const automationCategory = guild.channels.cache.find(
                c => c.name.toLowerCase() === 'automation' && c.type === ChannelType.GuildCategory
            );
            if (automationCategory) {
                await syncNextChangeVoiceChannel(guild, automationCategory).catch(() => { });
            }
        }
    }, 30 * 60 * 1000);
});

// Listener: Embedded Button Interactions
client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;

    const { customId } = interaction;

    // Button: Remove Slot Permission
    if (customId.startsWith('revoke_slot_perm:')) {
        const [, slotNumber, targetUserId] = customId.split(':');
        const modRole = await getOrCreateModeratorRole(interaction.guild);

        const isAuthorized = interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
            interaction.member.roles.cache.has(modRole.id);

        if (!isAuthorized) {
            return interaction.reply({
                content: 'Only Content Moderators and Administrators can remove slot permissions. / 権限の解除はモデレーターまたは管理者のみ実行できます。',
                ephemeral: true
            });
        }

        await interaction.channel.permissionOverwrites.delete(targetUserId).catch(() => { });

        const disabledRow = ActionRowBuilder.from(interaction.message.components[0]);
        disabledRow.components[0].setDisabled(true).setLabel('Permission Revoked / 権限解除済み');

        await interaction.update({ components: [disabledRow] }).catch(() => { });
        await interaction.channel.send(
            `<@${targetUserId}> Your access to **#slot-${slotNumber}** has been removed by <@${interaction.user.id}>.\n` +
            `このスロットへのアクセス権は <@${interaction.user.id}> によって解除されました。`
        );
        return;
    }

    // Buttons: Light Switches
    if (customId.startsWith('light_on_') || customId.startsWith('light_off_')) {
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
            if (err?.code === 10062) return;
            console.error('Error handling button interaction:', err);
        }
    }
});

// Listener: Reaction Added (Voting verification, Moderator deletion, Sightengine Check)
client.on(Events.MessageReactionAdd, async (reaction, user) => {
    if (user.bot) return;

    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (err) {
            return;
        }
    }

    const { message } = reaction;
    if (message.channel.name !== 'submissions') return;

    const guild = message.guild;
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return;

    const modRole = await getOrCreateModeratorRole(guild);
    const votersRole = await getOrCreateVotersRole(guild);
    const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator);
    const isMod = member.roles.cache.has(modRole.id);
    const isVoter = member.roles.cache.has(votersRole.id);

    // Vote Reaction: Strictly restricted to users with the Voters role
    if (reaction.emoji.name === '⬆️' || reaction.emoji.name === '⬇️') {
        if (!isVoter) {
            await reaction.users.remove(user.id).catch(() => { });
        }
        return;
    }

    // Trash Can Reaction: Delete submission (Content Moderators & Admins)
    if (reaction.emoji.name === '🗑️') {
        if (isMod || isAdmin) {
            await message.delete().catch(() => { });
        } else {
            await reaction.users.remove(user.id).catch(() => { });
        }
        return;
    }

    // Robot Reaction: Sightengine AI Image Detection Check
    if (reaction.emoji.name === '🤖') {
        if (!isMod && !isAdmin) {
            await reaction.users.remove(user.id).catch(() => { });
            return;
        }

        if (scannedAiSubmissions.has(message.id)) {
            await reaction.users.remove(user.id).catch(() => { });
            return;
        }

        const attachment = message.attachments.first();
        if (!attachment || !attachment.contentType?.startsWith('image/')) {
            await reaction.users.remove(user.id).catch(() => { });
            return;
        }

        scannedAiSubmissions.add(message.id);

        try {
            await message.reactions.cache.get('🤖')?.remove().catch(() => { });

            const result = await querySightengine(attachment.url);
            const aiScore = result.type?.ai_generated;
            const percent = (aiScore !== undefined) ? (aiScore * 100) : 0;
            const percentStr = (aiScore !== undefined) ? `${percent.toFixed(1)}%` : 'unknown%';
            const dateStr = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';

            const imageResponse = await fetch(attachment.url);
            const imageArrayBuffer = await imageResponse.arrayBuffer();
            const imageBuffer = Buffer.from(imageArrayBuffer);
            const fileName = attachment.name || 'submission.png';

            const authorId = message.author.id;
            const authorMember = await guild.members.fetch(authorId).catch(() => null);

            const aiLogsChannel = guild.channels.cache.find(c => c.name === 'ai-logs');
            let logStatusNote = '';

            if (percent > 55) {
                logStatusNote = ' - **[AUTO-DELETED & BLIND ROLE ASSIGNED]**';
            } else if (percent < 10) {
                logStatusNote = ' - **[MARKED WITH 🔵]**';
            } else {
                const rounded = Math.ceil(percent / 5) * 5;
                logStatusNote = ` - **[ROUNDED TO ${rounded}%]**`;
            }

            if (aiLogsChannel) {
                await aiLogsChannel.send({
                    content: `<@${authorId}> (${authorId}) submission at ${percentStr} certainty of AI generation on ${dateStr}${logStatusNote}`,
                    files: [{
                        attachment: imageBuffer,
                        name: fileName
                    }]
                });
            }

            if (percent > 55) {
                await message.delete().catch(() => { });
                if (authorMember) {
                    await applyBlindRole(authorMember, guild);
                }
            } else if (percent < 10) {
                await message.react('🔵').catch(() => { });
            } else {
                const rounded = Math.min(55, Math.max(10, Math.ceil(percent / 5) * 5));
                const digits = rounded.toString();
                const d1 = digits[0];
                const d2 = digits[1];

                await message.react(NUMBER_EMOJIS[d1]).catch(() => { });
                if (d1 !== d2) {
                    await message.react(NUMBER_EMOJIS[d2]).catch(() => { });
                } else {
                    await message.react('🖐️').catch(() => { });
                }
            }
        } catch (err) {
            console.error('Sightengine Analysis Error:', err);
            scannedAiSubmissions.delete(message.id);
        }
    }
});

client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot) return;

    // ----------------------------------------------------
    // COMMAND: !swap <1-16> <1-16>
    // ----------------------------------------------------
    if (message.content.startsWith('!swap')) {
        const modRole = await getOrCreateModeratorRole(message.guild);
        const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
        const isMod = message.member.roles.cache.has(modRole.id);

        if (!isAdmin && !isMod) {
            return message.reply('Only Content Moderators and Administrators can swap slots.');
        }

        const args = message.content.trim().split(/\s+/);
        if (args.length < 3) {
            return message.reply('Usage: `!swap <slot1> <slot2>`\nExample: `!swap 2 5`');
        }

        const slot1 = parseInt(args[1], 10);
        const slot2 = parseInt(args[2], 10);

        if (isNaN(slot1) || slot1 < 1 || slot1 > 16 || isNaN(slot2) || slot2 < 1 || slot2 > 16) {
            return message.reply('Please specify two valid slot numbers between 1 and 16.');
        }

        if (slot1 === slot2) {
            return message.reply('Please provide two different slot numbers to swap.');
        }

        await swapSlots({
            guild: message.guild,
            slot1,
            slot2,
            feedbackChannel: message.channel,
            operatorUser: message.author
        });
        return;
    }

    // ----------------------------------------------------
    // COMMAND: !approve <1-16> (Reply-to submission)
    // ----------------------------------------------------
    if (message.content.startsWith('!approve')) {
        const modRole = await getOrCreateModeratorRole(message.guild);
        const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);
        const isMod = message.member.roles.cache.has(modRole.id);

        if (!isAdmin && !isMod) {
            return message.reply('Only Content Moderators and Administrators can approve submissions.');
        }

        if (!message.reference || !message.reference.messageId) {
            return message.reply('Reply to the submission message you want to approve with `!approve <1-16>`.');
        }

        const args = message.content.trim().split(/\s+/);
        const slotNumber = parseInt(args[1], 10);
        if (isNaN(slotNumber) || slotNumber < 1 || slotNumber > 16) {
            return message.reply('Specify a valid slot number from 1 to 16. Example: `!approve 14`');
        }

        const targetMessage = await message.channel.messages.fetch(message.reference.messageId).catch(() => null);
        if (!targetMessage) {
            return message.reply('Could not find the replied-to submission message.');
        }

        const attachment = targetMessage.attachments.first();
        if (!attachment || !attachment.contentType?.startsWith('image/')) {
            return message.reply('The replied-to message does not contain a valid image attachment.');
        }

        const blurbContent = targetMessage.content.trim() || 'No description provided.';
        const submitter = targetMessage.author;

        try {
            const response = await fetch(attachment.url);
            const arrayBuffer = await response.arrayBuffer();
            const rawBuffer = Buffer.from(arrayBuffer);

            await deploySlotUpdate({
                guild: message.guild,
                slotNumber,
                rawImageBuffer: rawBuffer,
                blurbContent,
                submitter,
                approverUser: message.author,
                feedbackChannel: message.channel,
                submissionMessage: targetMessage,
                commandMessage: message
            });
        } catch (err) {
            console.error('Error during !approve:', err);
            message.reply(`Error deploying approval: ${err?.message || err}`);
        }
        return;
    }

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
            return message.reply('Usage: `!setswitchdesc <switch number or name> <new description>`');
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

        message.reply(`Granted **${targetMember.displayName}** access to **#${channelName}**.`);
        await targetChannel.send(
            `<@${targetMember.id}> You have been granted access to this channel. Upload an image with an optional caption. Your access remains active until your submission is accepted.\n` +
            `このチャンネルへのアクセス権が付与されました。画像と説明文（キャプション）を投稿してください。提出が承認されるまでアクセス権は保持されます。`
        );
        return;
    }

    // ----------------------------------------------------
    // COMMAND: !revoke @User <SlotNumber>
    // ----------------------------------------------------
    if (message.content.startsWith('!revoke')) {
        if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return message.reply('Only administrators can revoke access.');
        }

        const targetMember = message.mentions.members.first();
        const args = message.content.split(' ');
        const slotArg = args.find(arg => !isNaN(arg) && arg.trim() !== '');
        const slotNumber = parseInt(slotArg, 10);

        if (!targetMember || isNaN(slotNumber) || slotNumber < 1 || slotNumber > 16) {
            return message.reply('Usage: `!revoke @user <1-16>`\nExample: `!revoke @Alex 4`');
        }

        const channelName = `slot-${slotNumber}`;
        const targetChannel = message.guild.channels.cache.find(c => c.name === channelName);

        if (!targetChannel) {
            return message.reply(`Could not find channel #${channelName}.`);
        }

        await targetChannel.permissionOverwrites.delete(targetMember.id).catch(() => { });
        message.reply(`Revoked access for **${targetMember.displayName}** from **#${channelName}**.`);
        await targetChannel.send(
            `<@${targetMember.id}> Your access to this channel has been revoked by an administrator.\n` +
            `管理者によってこのチャンネルへのアクセス権が解除されました。`
        );
        return;
    }

    // ----------------------------------------------------
    // SUBMISSIONS CHANNEL HANDLER
    // ----------------------------------------------------
    if (message.channel.name === 'submissions') {
        const now = Date.now();
        const lastSubmit = submissionCooldowns.get(message.author.id);
        const isAdmin = message.member.permissions.has(PermissionFlagsBits.Administrator);

        if (!isAdmin && lastSubmit && (now - lastSubmit < THREE_DAYS_MS)) {
            const remainingHours = Math.ceil((THREE_DAYS_MS - (now - lastSubmit)) / (1000 * 60 * 60));
            await message.delete().catch(() => { });

            const warning = await message.channel.send(
                `<@${message.author.id}>\n` +
                `You may only post once every 3 days. Please wait ${remainingHours} more hour(s).\n` +
                `投稿は3日に1度のみ可能です。あと ${remainingHours} 時間お待ちください。`
            );
            setTimeout(() => warning.delete().catch(() => { }), 6000);
            return;
        }

        const attachment = message.attachments.first();
        const isImage = attachment && attachment.contentType?.startsWith('image/');
        const lines = message.content.trim().split(/\r?\n/).filter(line => line.trim().length > 0);

        if (!isImage || lines.length !== 3) {
            await message.delete().catch(() => { });

            const explanation = await message.channel.send(
                `<@${message.author.id}>\n` +
                `Submission rejected. Your post must include an image file and exactly 3 lines of text.\n` +
                `投稿が取り消されました。画像ファイルを1点添付し、テキストを正確に3行入力してください。`
            );
            setTimeout(() => explanation.delete().catch(() => { }), 7000);
            return;
        }

        if (!isAdmin) {
            submissionCooldowns.set(message.author.id, now);
        }

        try {
            await message.react('⬆️');
            await message.react('⬇️');
            await message.react('🗑️');
            await message.react('🤖');
        } catch (err) {
            console.error('Error adding reactions to submission:', err);
        }
        return;
    }

    // ----------------------------------------------------
    // LISTENER: Direct image upload in slot channels
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
        const warning = await message.channel.send(
            `<@${message.author.id}> Please attach an image file (with optional blurb text in the caption).\n` +
            `画像ファイルを添付してください（キャプションに説明文を入力可能）。`
        );
        setTimeout(() => warning.delete().catch(() => { }), 4000);
        return;
    }

    const blurbContent = message.content.trim() || 'No description provided.';
    const submitter = message.author;

    try {
        const response = await fetch(attachment.url);
        const arrayBuffer = await response.arrayBuffer();
        const rawBuffer = Buffer.from(arrayBuffer);

        await message.channel.permissionOverwrites.edit(modRole.id, {
            ViewChannel: true,
            ReadMessageHistory: true,
            SendMessages: true,
            AddReactions: true
        });

        const approvalEmbed = new EmbedBuilder()
            .setTitle(`Review Required: Slot #${slotNumber} / 承認待ち`)
            .setColor('#f1c40f')
            .setDescription(
                `**Submitted By / 投稿者:** ${submitter.tag} (<@${submitter.id}>)\n\n` +
                `**Proposed Blurb / 提案された説明文:**\n${blurbContent}`
            )
            .setImage(attachment.url)
            .setFooter({ text: 'React ✅ to approve | React ❌ to reject\n承認は ✅ | 却下は ❌' })
            .setTimestamp();

        const revokeButtonRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`revoke_slot_perm:${slotNumber}:${submitter.id}`)
                .setLabel('Remove Slot Permission / 権限解除')
                .setStyle(ButtonStyle.Danger)
        );

        const modPrompt = await message.channel.send({
            content:
                `<@&${modRole.id}> A new image has been submitted for **Slot #${slotNumber}** by <@${submitter.id}>.\n` +
                `<@${submitter.id}> Your submission is pending moderator approval. You retain channel access until it is accepted.\n` +
                `**Slot #${slotNumber}** に新しい画像が投稿されました。承認待ちです（承認されるまでアクセス権は保持されます）。`,
            embeds: [approvalEmbed],
            components: [revokeButtonRow]
        });

        await modPrompt.react('✅');
        await modPrompt.react('❌');

        const collector = modPrompt.createReactionCollector({
            filter: async (reaction, user) => {
                if (user.bot) return false;
                if (!['✅', '❌'].includes(reaction.emoji.name)) return false;

                const member = await message.guild.members.fetch(user.id).catch(() => null);
                if (!member) return false;

                const isAuthorized = member.roles.cache.has(modRole.id) || member.permissions.has(PermissionFlagsBits.Administrator);
                if (!isAuthorized) {
                    await reaction.users.remove(user.id).catch(() => { });
                    return false;
                }
                return true;
            },
            time: 86400000 // 24 hours
        });

        collector.on('collect', async (reaction, user) => {
            collector.stop('handled');

            await message.delete().catch(() => { });
            await modPrompt.delete().catch(() => { });
            await message.channel.permissionOverwrites.delete(modRole.id).catch(() => { });

            if (reaction.emoji.name === '✅') {
                await deploySlotUpdate({
                    guild: message.guild,
                    slotNumber,
                    rawImageBuffer: rawBuffer,
                    blurbContent,
                    submitter,
                    approverUser: user,
                    feedbackChannel: message.channel
                });
            } else if (reaction.emoji.name === '❌') {
                await message.channel.send(
                    `Submission rejected by ${user.tag}. Resetting channel view...\n` +
                    `${user.tag} によって却下されました。チャンネル表示をリセットしています...`
                );
                await message.channel.send(
                    `<@${submitter.id}> Your submission for **Slot #${slotNumber}** was rejected. You retain channel access to submit a revised image and blurb.\n` +
                    `スロット #${slotNumber} への投稿は却下されました。修正した画像と説明文を再度投稿してください。`
                );

                await new Promise(resolve => setTimeout(resolve, 3000));
                await renderSlotChannel(message.channel, slotNumber);
            }
        });

        collector.on('end', async (collected, reason) => {
            if (reason === 'time') {
                await message.delete().catch(() => { });
                await modPrompt.delete().catch(() => { });
                await message.channel.permissionOverwrites.delete(modRole.id).catch(() => { });
                await message.channel.send(
                    `Review for Slot #${slotNumber} timed out without a decision.\n` +
                    `スロット #${slotNumber} の確認期限が切れました。`
                );
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
