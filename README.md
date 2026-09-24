# Ryo WhatsApp AI Assistant

Full project package for the Ryo bot.

## Fitur
- WhatsApp pairing + persistent auth
- AI chat, persona, coding, translation, essay, summary, grammar
- TikTok / Instagram / YouTube / Facebook downloader
- Sticker, HD image, AI art
- Express health/web endpoint
- PM2-ready

## Instalasi Termux
```bash
pkg update -y
pkg install nodejs ffmpeg git unzip -y
cd ~/Ryo
npm install
cp .env.example .env
nano .env
node --check index.js
npm start
```

## PM2
```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 logs ryo
```

Jangan commit `.env`, `auth/`, atau data lokal. Folder auth berisi kredensial WhatsApp.

## Command utama
`.menu` `.persona santai` `@halo ryo` `.code ...` `.tr en ...` `.essay ...` `.rangkum ...` `.grammar ...` `.s/.sticker` `.hd/.remini` `.gambar ...` `.anime ...` `.3d ...` `.pixel ...` `.logo ...` `.cyberpunk ...` `.sketch ...` `.tt ...` `.ig ...` `.yt ...` `.fb ...`
