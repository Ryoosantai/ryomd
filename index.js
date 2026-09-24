const fs = require('fs');
const path = require('path');
const pino = require('pino');
const axios = require('axios');
const express = require('express');
const FormData = require('form-data');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const jimpPkg = require('jimp');
const Jimp = jimpPkg.Jimp || jimpPkg;

const app = express();
const PORT = Number(process.env.PORT || 3000);
app.get('/', (_req, res) => res.send('🤖 Ryo Assistant Web Server Active v5.0'));
app.listen(PORT, () => console.log(`🌐 Web server aktif di port ${PORT}`));

const startTime = Date.now();
const PHONE_NUMBER = process.env.PHONE_NUMBER || '6283829451488';
const AUTH_DIR = path.join(__dirname, 'auth');
const PERSONA_FILE = path.join(__dirname, 'personas.json');
const TMP_DIR = path.join(__dirname, 'tmp');
fs.mkdirSync(TMP_DIR, { recursive: true });

const log = pino({ level: process.env.LOG_LEVEL || 'info' });

function getPersona(jid) {
    if (!jid || typeof jid !== 'string') return 'santai';
    try {
        if (!fs.existsSync(PERSONA_FILE)) return 'santai';
        const data = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8'));
        return data[jid] || 'santai';
    } catch {
        return 'santai';
    }
}

function setPersona(jid, persona) {
    if (!jid || typeof jid !== 'string') return;
    let data = {};
    try {
        if (fs.existsSync(PERSONA_FILE)) {
            data = JSON.parse(fs.readFileSync(PERSONA_FILE, 'utf8'));
        }
    } catch {}
    data[jid] = persona;
    fs.writeFileSync(PERSONA_FILE, JSON.stringify(data, null, 2));
}

function formatUptime(ms) {
    const seconds = Math.floor((ms / 1000) % 60);
    const minutes = Math.floor((ms / (1000 * 60)) % 60);
    const hours = Math.floor((ms / (1000 * 60 * 60)) % 24);
    const days = Math.floor(ms / (1000 * 60 * 60 * 24));
    return `${days}d ${hours}h ${minutes}m ${seconds}s`;
}

function cleanUrl(value) {
    const match = String(value || '').trim().match(/https?:\/\/[^\s]+/i);
    return match ? match[0].replace(/[)>\]}.,!?]+$/g, '') : '';
}

function unwrapMessage(message) {
    let current = message;
    for (let i = 0; i < 6; i++) {
        const next = current?.ephemeralMessage?.message
            || current?.viewOnceMessage?.message
            || current?.viewOnceMessageV2?.message
            || current?.viewOnceMessageV2Extension?.message
            || current?.documentWithCaptionMessage?.message;
        if (!next) break;
        current = next;
    }
    return current || message;
}

function getBody(rawMessage) {
    const message = unwrapMessage(rawMessage);
    return (
        message?.conversation ||
        message?.extendedTextMessage?.text ||
        message?.imageMessage?.caption ||
        message?.videoMessage?.caption ||
        message?.documentMessage?.caption ||
        message?.buttonsResponseMessage?.selectedButtonId ||
        message?.listResponseMessage?.singleSelectReply?.selectedRowId ||
        ''
    ).trim();
}

function getQuotedMessage(rawMessage) {
    const message = unwrapMessage(rawMessage);
    return message?.extendedTextMessage?.contextInfo?.quotedMessage ||
        message?.imageMessage?.contextInfo?.quotedMessage ||
        message?.videoMessage?.contextInfo?.quotedMessage ||
        null;
}

function getQuotedContext(rawMessage) {
    const message = unwrapMessage(rawMessage);
    return message?.extendedTextMessage?.contextInfo ||
        message?.imageMessage?.contextInfo ||
        message?.videoMessage?.contextInfo ||
        {};
}

function hasImage(message) {
    return !!unwrapMessage(message)?.imageMessage;
}

async function downloadTargetMessage(sock, rawMessage, baileys) {
    const { downloadMediaMessage } = baileys;
    const direct = unwrapMessage(rawMessage)?.imageMessage;
    const quoted = getQuotedMessage(rawMessage);

    if (!direct && !quoted?.imageMessage) return null;

    let target = rawMessage;
    if (!direct && quoted?.imageMessage) {
        const ctx = getQuotedContext(rawMessage);
        target = {
            key: {
                remoteJid: rawMessage.key.remoteJid,
                id: ctx.stanzaId || `quoted-${Date.now()}`,
                participant: ctx.participant,
                fromMe: false
            },
            message: quoted
        };
    }

    return await downloadMediaMessage(
        target,
        'buffer',
        {},
        { logger: pino({ level: 'silent' }) }
    );
}

async function askAI(prompt, persona = 'santai') {
    let systemPrompt = 'Kamu adalah Ryo, asisten AI WhatsApp yang santai, pintar, ramah, dan gaul. Jawab jelas dan membantu.';
    if (persona === 'pemarah') {
        systemPrompt = 'Kamu adalah Ryo, asisten AI yang suka ngomel dan sarkas ringan, tetapi tetap sopan, aman, dan menjawab pertanyaan dengan benar.';
    } else if (persona === 'pendiam') {
        systemPrompt = 'Kamu adalah Ryo, asisten AI yang pendiam, dingin, singkat, dan sangat to the point. Tetap akurat dan membantu.';
    }
    return callAI(systemPrompt, prompt);
}

async function callAI(systemPrompt, userPrompt) {
    const url = 'https://text.pollinations.ai/openai';
    try {
        const response = await axios.post(url, {
            model: 'openai',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt }
            ],
            stream: false
        }, {
            timeout: 45000,
            headers: { 'Content-Type': 'application/json' }
        });

        const data = response.data;
        const result = typeof data === 'string'
            ? data
            : data?.choices?.[0]?.message?.content || data?.output_text || data?.response || '';

        if (result) return String(result).trim();
    } catch (err) {
        log.warn(`[AI POST] ${err.message}`);
    }

    // Fallback ke endpoint GET lama yang masih didokumentasikan.
    try {
        const response = await axios.get(`https://text.pollinations.ai/${encodeURIComponent(userPrompt)}`, {
            params: {
                model: 'openai',
                system: systemPrompt,
                private: 'true'
            },
            timeout: 45000,
            responseType: 'text'
        });
        if (response.data) return String(response.data).trim();
    } catch (err) {
        log.warn(`[AI GET] ${err.message}`);
    }

    return '❌ Koneksi AI sedang bermasalah. Coba lagi sebentar ya ngab.';
}

function generateImageUrl(prompt, style = 'flux') {
    const prefixes = {
        flux: '',
        anime: 'anime style, masterpiece, highly detailed, ',
        '3d': '3D render, octane render, Unreal Engine, highly detailed, ',
        pixel: 'pixel art, 16-bit retro game style, ',
        logo: 'minimalist vector logo, clean emblem, flat graphic design, ',
        cyberpunk: 'cyberpunk, neon lights, futuristic atmosphere, ',
        sketch: 'pencil sketch, detailed line art, hand drawn, '
    };
    const modifiedPrompt = `${prefixes[style] || ''}${prompt}`;
    const seed = Math.floor(Math.random() * 1000000);
    return `https://image.pollinations.ai/prompt/${encodeURIComponent(modifiedPrompt)}?width=1024&height=1024&seed=${seed}&nologo=true&model=flux&safe=true`;
}

async function uploadMedia(mediaBuffer) {
    if (!Buffer.isBuffer(mediaBuffer)) return null;
    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', mediaBuffer, { filename: 'image.jpg', contentType: 'image/jpeg' });
        const res = await axios.post('https://catbox.moe/user/api.php', form, {
            headers: form.getHeaders(),
            timeout: 30000,
            maxBodyLength: 20 * 1024 * 1024
        });
        const url = String(res.data || '').trim();
        return url.startsWith('http') ? url : null;
    } catch (err) {
        log.warn(`[Catbox] ${err.message}`);
        return null;
    }
}

async function processHDImage(imageUrl, mediaBuffer) {
    if (imageUrl) {
        const apis = [
            `https://widipe.com/remini?url=${encodeURIComponent(imageUrl)}`,
            `https://itzpire.site/tools/remini?url=${encodeURIComponent(imageUrl)}`
        ];

        for (const api of apis) {
            try {
                const res = await axios.get(api, { timeout: 20000 });
                const resultUrl = res.data?.url || res.data?.result || res.data?.data || res.data?.image;
                if (typeof resultUrl === 'string' && /^https?:\/\//i.test(resultUrl)) {
                    return { url: resultUrl, mode: 'AI Online' };
                }
            } catch (err) {
                log.debug(`[HD API] ${err.message}`);
            }
        }
    }

    if (!Buffer.isBuffer(mediaBuffer)) return null;
    try {
        const image = await Jimp.read(mediaBuffer);
        if (typeof image.scale === 'function') image.scale(2);
        if (typeof image.normalize === 'function') image.normalize();
        if (typeof image.contrast === 'function') image.contrast(0.12);
        const mime = Jimp.MIME_JPEG || 'image/jpeg';
        let localBuffer;
        if (typeof image.getBufferAsync === 'function') localBuffer = await image.getBufferAsync(mime);
        else if (typeof image.getBuffer === 'function') localBuffer = await image.getBuffer(mime);
        return Buffer.isBuffer(localBuffer) ? { buffer: localBuffer, mode: 'Jimp Lokal' } : null;
    } catch (err) {
        log.warn(`[HD Local] ${err.message}`);
        return null;
    }
}

async function fetchJson(url, options = {}) {
    const res = await axios.get(url, {
        timeout: 25000,
        maxRedirects: 5,
        ...options
    });
    return res.data;
}

function normalizeDownloadUrl(value) {
    if (typeof value !== 'string') return null;
    const url = value.trim();
    return /^https?:\/\//i.test(url) ? url : null;
}

function extractVideoUrl(data) {
    const candidates = [
        data?.data?.play,
        data?.data?.video,
        data?.data?.no_watermark,
        data?.result?.video,
        data?.result?.nowm,
        data?.result?.hd,
        data?.result?.sd,
        data?.result?.mp4,
        data?.video,
        data?.hd,
        data?.sd,
        data?.url
    ];
    for (const item of candidates) {
        const url = normalizeDownloadUrl(item);
        if (url) return url;
    }
    return null;
}

async function tryTikTok(url) {
    const endpoints = [
        `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`,
        `https://itzpire.site/download/tiktok?url=${encodeURIComponent(url)}`,
        `https://aetherz.xyz/api/tiktok?url=${encodeURIComponent(url)}`,
        `https://widipe.com/download/tiktok?url=${encodeURIComponent(url)}`
    ];
    for (const endpoint of endpoints) {
        try {
            const data = await fetchJson(endpoint, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/120 Safari/537.36',
                    'Accept': 'application/json,text/plain,*/*'
                }
            });
            const videoUrl = extractVideoUrl(data);
            if (videoUrl) {
                return {
                    videoUrl,
                    author: data?.data?.author?.unique_id || data?.data?.author || data?.result?.author || 'User',
                    title: data?.data?.title || data?.result?.title || 'TikTok Video'
                };
            }
        } catch (err) {
            log.debug(`[TikTok] ${err.message}`);
        }
    }
    return null;
}

async function tryInstagram(url) {
    const endpoints = [
        `https://widipe.com/download/igdl?url=${encodeURIComponent(url)}`,
        `https://itzpire.site/download/ig?url=${encodeURIComponent(url)}`
    ];
    for (const endpoint of endpoints) {
        try {
            const data = await fetchJson(endpoint);
            const raw = data?.result || data?.data || data;
            const list = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
            const media = [];
            for (const item of list) {
                const candidate = normalizeDownloadUrl(item?.url || item?.image || item?.video || item);
                if (candidate) media.push(candidate);
            }
            if (media.length) return media;
        } catch (err) {
            log.debug(`[Instagram] ${err.message}`);
        }
    }
    return null;
}

async function tryYouTube(url) {
    const endpoints = [
        `https://widipe.com/download/ytdl?url=${encodeURIComponent(url)}`,
        `https://itzpire.site/download/youtube?url=${encodeURIComponent(url)}`
    ];
    for (const endpoint of endpoints) {
        try {
            const data = await fetchJson(endpoint);
            const videoUrl = extractVideoUrl(data);
            if (videoUrl) {
                return {
                    videoUrl,
                    title: data?.result?.title || data?.data?.title || 'YouTube Video'
                };
            }
        } catch (err) {
            log.debug(`[YouTube] ${err.message}`);
        }
    }
    return null;
}

async function tryFacebook(url) {
    const endpoints = [
        `https://api.siputzx.my.id/api/d/facebook?url=${encodeURIComponent(url)}`,
        `https://widipe.com/download/facebook?url=${encodeURIComponent(url)}`,
        `https://itzpire.site/download/facebook?url=${encodeURIComponent(url)}`
    ];

    for (const endpoint of endpoints) {
        try {
            const data = await fetchJson(endpoint);
            const downloads = data?.data?.downloads || data?.downloads || data?.result?.downloads;
            if (Array.isArray(downloads) && downloads.length) {
                const hd = downloads.find(x => String(x?.quality || '').toUpperCase().includes('HD')) || downloads[0];
                const videoUrl = normalizeDownloadUrl(hd?.url || hd?.download || hd?.link);
                if (videoUrl) {
                    return {
                        videoUrl,
                        title: data?.data?.title || data?.title || 'Facebook Video',
                        quality: hd?.quality || 'Best'
                    };
                }
            }

            const direct = extractVideoUrl(data);
            if (direct) {
                return {
                    videoUrl: direct,
                    title: data?.data?.title || data?.result?.title || 'Facebook Video',
                    quality: 'Best'
                };
            }
        } catch (err) {
            log.debug(`[Facebook] ${err.message}`);
        }
    }
    return null;
}

async function sendRemoteVideo(sock, from, url, caption, quoted) {
    try {
        return await sock.sendMessage(from, { video: { url }, caption }, { quoted });
    } catch (err) {
        // Fallback: ambil buffer lalu kirim. Berguna untuk host CDN yang menolak fetch langsung.
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 60000,
                maxContentLength: 100 * 1024 * 1024,
                maxBodyLength: 100 * 1024 * 1024,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            return await sock.sendMessage(from, { video: Buffer.from(response.data), caption }, { quoted });
        } catch (fallbackErr) {
            throw new Error(`media send failed: ${fallbackErr.message}`);
        }
    }
}

async function sendRemoteImage(sock, from, url, caption, quoted) {
    try {
        return await sock.sendMessage(from, { image: { url }, caption }, { quoted });
    } catch (err) {
        try {
            const response = await axios.get(url, {
                responseType: 'arraybuffer',
                timeout: 45000,
                maxContentLength: 20 * 1024 * 1024,
                maxBodyLength: 20 * 1024 * 1024,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            });
            return await sock.sendMessage(from, { image: Buffer.from(response.data), caption }, { quoted });
        } catch (fallbackErr) {
            throw new Error(`image send failed: ${fallbackErr.message}`);
        }
    }
}

async function makeSticker(sock, from, rawMessage, baileys) {
    const mediaBuffer = await downloadTargetMessage(sock, rawMessage, baileys);
    if (!mediaBuffer) throw new Error('Foto tidak ditemukan.');

    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const input = path.join(TMP_DIR, `${stamp}.jpg`);
    const output = path.join(TMP_DIR, `${stamp}.webp`);

    try {
        fs.writeFileSync(input, mediaBuffer);
        await execFileAsync('ffmpeg', [
            '-y', '-i', input,
            '-vcodec', 'libwebp',
            '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,format=rgba,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=#00000000',
            '-lossless', '1',
            '-compression_level', '4',
            output
        ], { timeout: 30000 });

        if (!fs.existsSync(output)) throw new Error('Output sticker tidak ada.');
        return fs.readFileSync(output);
    } finally {
        for (const file of [input, output]) {
            try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch {}
        }
    }
}

const artStyles = {
    '.gambar': 'flux',
    '.anime': 'anime',
    '.3d': '3d',
    '.pixel': 'pixel',
    '.logo': 'logo',
    '.cyberpunk': 'cyberpunk',
    '.sketch': 'sketch'
};

async function startBot() {
    // Dynamic import menjaga kompatibilitas dengan Baileys versi baru yang lebih ESM-oriented.
    const baileys = await import('@whiskeysockets/baileys');
    const makeWASocket = baileys.default;
    const { useMultiFileAuthState, DisconnectReason } = baileys;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }),
        markOnlineOnConnect: false
    });

    sock.ev.on('creds.update', saveCreds);

    if (!state.creds.registered) {
        console.log('⏳ Meminta kode pairing...');
        setTimeout(async () => {
            try {
                const code = await sock.requestPairingCode(PHONE_NUMBER);
                console.log(`\\n🔑 KODE PAIRING RYO: ${code}\\n`);
            } catch (err) {
                console.error('❌ Pairing gagal:', err.message);
            }
        }, 3000);
    }

    sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
        if (connection === 'open') {
            console.log('✅ RYO ASSISTANT v5.0 SIAP DIGUNAKAN!');
            return;
        }

        if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.error(`🔴 Koneksi terputus. Code: ${reason ?? 'unknown'}`);

            if (reason === DisconnectReason.loggedOut) {
                console.error('🔐 Sesi logout. Folder auth dihapus; jalankan ulang untuk pairing baru.');
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                return process.exit(1);
            }

            // Biarkan PM2 menangani restart agar tidak terjadi reconnect loop ganda.
            return process.exit(1);
        }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;

        for (const msg of messages) {
            try {
                if (!msg?.message || msg.key?.fromMe) continue;

                const from = msg.key.remoteJid;
                if (!from || from === 'status@broadcast') continue;

                const rawMessage = msg.message;
                const body = getBody(rawMessage);
                if (!body) continue;

                const parts = body.split(/\s+/);
                const command = (parts.shift() || '').toLowerCase();
                const text = parts.join(' ').trim();
                const currentPersona = getPersona(from);
                const imageAvailable = hasImage(rawMessage) || !!getQuotedMessage(rawMessage)?.imageMessage;

                if (command === '.menu' || command === '.help') {
                    const menuText = `╭━━━〔 *RYO ASSISTANT v5.0* 〕━━━
│ 🤖 Engine: Active
│ ⏱️ Uptime: ${formatUptime(Date.now() - startTime)}
│ 🎭 Persona: ${currentPersona.toUpperCase()}
│ ⚡ Status: Online
╰━━━━━━━━━━━━━━━━━━━━━━━

╭━━〔 📥 DOWNLOADER 〕
┊ • *.tt <link>* — TikTok
┊ • *.ig <link>* — Instagram
┊ • *.yt <link>* — YouTube
┊ • *.fb <link>* — Facebook
╰━━━━━━━━━━━━━━━━━━━━━━━

╭━━〔 🧠 AI 〕
┊ • *.persona <santai|pemarah|pendiam>*
┊ • *@<teks>* — Tanya Ryo AI
┊ • *.code <req>* — Coding
┊ • *.tr <kode_bhs> <teks>* — Translate
┊ • *.essay <topik>* — Esai
┊ • *.rangkum <teks>* — Ringkas
┊ • *.grammar <teks>* — Koreksi
╰━━━━━━━━━━━━━━━━━━━━━━━

╭━━〔 🖼️ MEDIA 〕
┊ • *.sticker* / *.s* — Foto → Stiker
┊ • *.hd* / *.remini* — HD Foto
╰━━━━━━━━━━━━━━━━━━━━━━━

╭━━〔 🎨 AI ART 〕
┊ • *.gambar <prompt>*
┊ • *.anime <prompt>*
┊ • *.3d <prompt>*
┊ • *.pixel <prompt>*
┊ • *.logo <prompt>*
┊ • *.cyberpunk <prompt>*
┊ • *.sketch <prompt>*
╰━━━━━━━━━━━━━━━━━━━━━━━`;
                    await sock.sendMessage(from, { text: menuText }, { quoted: msg });
                    continue;
                }

                if (command === '.persona') {
                    const allowed = ['santai', 'pemarah', 'pendiam'];
                    if (!allowed.includes(text.toLowerCase())) {
                        await sock.sendMessage(from, { text: '⚠️ Pilih: `santai`, `pemarah`, atau `pendiam`.' }, { quoted: msg });
                    } else {
                        setPersona(from, text.toLowerCase());
                        await sock.sendMessage(from, { text: `✅ Persona diubah ke *${text.toUpperCase()}*` }, { quoted: msg });
                    }
                    continue;
                }

                if (command === '.sticker' || command === '.s') {
                    if (!imageAvailable) {
                        await sock.sendMessage(from, { text: '⚠️ Kirim foto atau reply foto dengan `.s` / `.sticker`.' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '⏳ Membuat stiker...' }, { quoted: msg });
                    try {
                        const sticker = await makeSticker(sock, from, msg, baileys);
                        await sock.sendMessage(from, { sticker }, { quoted: msg });
                    } catch (err) {
                        log.error(`[Sticker] ${err.message}`);
                        await sock.sendMessage(from, { text: '❌ Gagal membuat stiker. Pastikan `ffmpeg` terpasang.' }, { quoted: msg });
                    }
                    continue;
                }

                if (command === '.hd' || command === '.remini') {
                    if (!imageAvailable) {
                        await sock.sendMessage(from, { text: '⚠️ Kirim atau reply foto dengan `.hd`.' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '✨ Memproses foto HD...' }, { quoted: msg });
                    try {
                        const mediaBuffer = await downloadTargetMessage(sock, msg, baileys);
                        if (!mediaBuffer) throw new Error('media kosong');
                        const imageUrl = await uploadMedia(mediaBuffer);
                        const result = await processHDImage(imageUrl, mediaBuffer);
                        if (result?.url) {
                            await sendRemoteImage(sock, from, result.url, '✨ *Foto berhasil dijernihkan!*', msg);
                        } else if (result?.buffer) {
                            await sock.sendMessage(from, { image: result.buffer, caption: '✨ *Foto berhasil dijernihkan!*' }, { quoted: msg });
                        } else {
                            await sock.sendMessage(from, { text: '❌ Tidak ada engine HD yang berhasil.' }, { quoted: msg });
                        }
                    } catch (err) {
                        log.error(`[HD] ${err.message}`);
                        await sock.sendMessage(from, { text: '❌ Gagal memproses foto HD.' }, { quoted: msg });
                    }
                    continue;
                }

                if (artStyles[command]) {
                    if (!text) {
                        await sock.sendMessage(from, { text: `⚠️ Contoh: ${command} kucing astronot di bulan` }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '🎨 Sedang menggambar...' }, { quoted: msg });
                    try {
                        const imageUrl = generateImageUrl(text, artStyles[command]);
                        await sendRemoteImage(sock, from, imageUrl, `✅ *AI Art ${artStyles[command].toUpperCase()}*\n📝 ${text}`, msg);
                    } catch (err) {
                        log.error(`[Art] ${err.message}`);
                        await sock.sendMessage(from, { text: '❌ Gagal membuat gambar.' }, { quoted: msg });
                    }
                    continue;
                }

                if (command === '.tr') {
                    if (!text) {
                        await sock.sendMessage(from, { text: '⚠️ Format: `.tr en Halo apa kabar`' }, { quoted: msg });
                        continue;
                    }
                    const [lang, ...rest] = text.split(/\s+/);
                    const toTranslate = rest.join(' ').trim();
                    if (!toTranslate) {
                        await sock.sendMessage(from, { text: '⚠️ Teks terjemahan kosong.' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '🌐 Menerjemahkan...' }, { quoted: msg });
                    const result = await callAI(
                        `Kamu adalah penerjemah profesional. Terjemahkan ke bahasa dengan kode "${lang}". Jawab hanya hasil terjemahannya.`,
                        toTranslate
                    );
                    await sock.sendMessage(from, { text: `🌐 *Terjemahan ${lang.toUpperCase()}*\n\n${result}` }, { quoted: msg });
                    continue;
                }

                if (command === '.essay') {
                    if (!text) {
                        await sock.sendMessage(from, { text: '⚠️ Contoh: `.essay pentingnya pendidikan`' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '✍️ Menulis esai...' }, { quoted: msg });
                    const result = await callAI(
                        'Kamu adalah penulis esai profesional berbahasa Indonesia. Tulis esai terstruktur dengan pembukaan, isi, dan penutup sekitar 300-400 kata.',
                        text
                    );
                    await sock.sendMessage(from, { text: `📄 *Esai: ${text}*\n\n${result}` }, { quoted: msg });
                    continue;
                }

                if (command === '.rangkum') {
                    if (!text) {
                        await sock.sendMessage(from, { text: '⚠️ Gunakan `.rangkum <teks>`.' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '📋 Merangkum...' }, { quoted: msg });
                    const result = await callAI('Ringkas teks berikut menjadi poin-poin singkat dan jelas dalam bahasa Indonesia.', text);
                    await sock.sendMessage(from, { text: `📋 *Ringkasan*\n\n${result}` }, { quoted: msg });
                    continue;
                }

                if (command === '.grammar') {
                    if (!text) {
                        await sock.sendMessage(from, { text: '⚠️ Gunakan `.grammar <teks>`.' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '📝 Mengecek grammar...' }, { quoted: msg });
                    const result = await callAI(
                        'Perbaiki ejaan, tata bahasa, dan kejelasan kalimat berikut. Format jawaban: ✅ Hasil Perbaikan: ...\n💡 Penjelasan: ...',
                        text
                    );
                    await sock.sendMessage(from, { text: result }, { quoted: msg });
                    continue;
                }

                if (command === '.code') {
                    if (!text) {
                        await sock.sendMessage(from, { text: '⚠️ Contoh: `.code buat fungsi fibonacci JavaScript`' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '💻 Ryo sedang ngoding...' }, { quoted: msg });
                    const result = await callAI(
                        'Kamu adalah asisten programmer ahli. Berikan kode yang rapi dan benar. Jelaskan singkat lalu tampilkan kode dalam markdown code block.',
                        text
                    );
                    await sock.sendMessage(from, { text: result }, { quoted: msg });
                    continue;
                }

                const mediaCommand = command;
                const url = cleanUrl(text);

                if (['.tt', '.tiktok'].includes(mediaCommand)) {
                    if (!url) {
                        await sock.sendMessage(from, { text: '⚠️ Kirim link TikTok.' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '⏳ Mengambil video TikTok...' }, { quoted: msg });
                    const data = await tryTikTok(url);
                    if (!data) {
                        await sock.sendMessage(from, { text: '❌ TikTok gagal diambil. Server downloader sedang tidak tersedia.' }, { quoted: msg });
                    } else {
                        try {
                            await sendRemoteVideo(sock, from, data.videoUrl, `✅ *TikTok Downloader*\n👤 @${data.author}\n📝 ${data.title}`, msg);
                        } catch (err) {
                            log.error(`[TikTok Send] ${err.message}`);
                            await sock.sendMessage(from, { text: '❌ Video ditemukan tetapi gagal dikirim ke WhatsApp.' }, { quoted: msg });
                        }
                    }
                    continue;
                }

                if (['.ig', '.instagram'].includes(mediaCommand)) {
                    if (!url) {
                        await sock.sendMessage(from, { text: '⚠️ Kirim link Instagram.' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '⏳ Mengambil media Instagram...' }, { quoted: msg });
                    const media = await tryInstagram(url);
                    if (!media?.length) {
                        await sock.sendMessage(from, { text: '❌ Gagal mengambil Instagram. Pastikan link publik.' }, { quoted: msg });
                    } else {
                        let sent = 0;
                        for (const item of media.slice(0, 10)) {
                            try {
                                // Coba deteksi tipe dari URL.
                                if (/\.(jpe?g|png|webp)(?:\?|$)/i.test(item)) {
                                    await sendRemoteImage(sock, from, item, '✅ *Instagram Downloader*', msg);
                                } else {
                                    await sendRemoteVideo(sock, from, item, '✅ *Instagram Downloader*', msg);
                                }
                                sent++;
                            } catch (err) {
                                log.warn(`[Instagram media] ${err.message}`);
                            }
                        }
                        if (!sent) await sock.sendMessage(from, { text: '❌ Media ditemukan tetapi gagal dikirim.' }, { quoted: msg });
                    }
                    continue;
                }

                if (['.yt', '.youtube'].includes(mediaCommand)) {
                    if (!url) {
                        await sock.sendMessage(from, { text: '⚠️ Kirim link YouTube.' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '⏳ Mengambil YouTube MP4...' }, { quoted: msg });
                    const data = await tryYouTube(url);
                    if (!data) {
                        await sock.sendMessage(from, { text: '❌ YouTube gagal diambil. Server downloader sedang tidak tersedia.' }, { quoted: msg });
                    } else {
                        try {
                            await sendRemoteVideo(sock, from, data.videoUrl, `✅ *YouTube Downloader*\n📌 ${data.title}`, msg);
                        } catch (err) {
                            log.error(`[YouTube Send] ${err.message}`);
                            await sock.sendMessage(from, { text: '❌ Video ditemukan tetapi terlalu besar/gagal dikirim.' }, { quoted: msg });
                        }
                    }
                    continue;
                }

                if (['.fb', '.facebook'].includes(mediaCommand)) {
                    if (!url) {
                        await sock.sendMessage(from, { text: '⚠️ Kirim link Facebook.' }, { quoted: msg });
                        continue;
                    }
                    await sock.sendMessage(from, { text: '⏳ Mengambil video Facebook...' }, { quoted: msg });
                    const data = await tryFacebook(url);
                    if (!data) {
                        await sock.sendMessage(from, { text: '❌ Facebook gagal diambil. Pastikan videonya publik dan link masih aktif.' }, { quoted: msg });
                    } else {
                        try {
                            await sendRemoteVideo(sock, from, data.videoUrl, `✅ *Facebook Downloader*\n📝 ${data.title}\n🎞️ Kualitas: ${data.quality}`, msg);
                        } catch (err) {
                            log.error(`[Facebook Send] ${err.message}`);
                            await sock.sendMessage(from, { text: '❌ Video Facebook ditemukan tetapi gagal dikirim.' }, { quoted: msg });
                        }
                    }
                    continue;
                }

                // Tanya AI dengan format @teks
                if (body.startsWith('@')) {
                    const query = body.slice(1).trim();
                    if (!query) continue;
                    const reply = await askAI(query, currentPersona);
                    const aiResponse = `╭━━━〔 🤖 *RYO AI ${currentPersona.toUpperCase()}* 〕━━━\n│\n${reply}\n│\n╰━━━━━━━━━━━━━━━━━━━━━━━`;
                    await sock.sendMessage(from, { text: aiResponse }, { quoted: msg });
                }
            } catch (err) {
                log.error(`[Error Pesan] ${err.stack || err.message}`);
            }
        }
    });
}

startBot().catch(err => {
    console.error('❌ Gagal menjalankan Ryo:', err.stack || err.message);
    process.exit(1);
});
