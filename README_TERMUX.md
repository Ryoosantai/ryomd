# Ryo - Termux

1. `cd ~/Ryo`
2. `npm install`
3. `cp .env.example .env`
4. Isi `PHONE_NUMBER` di `.env`.
5. `node --check index.js`
6. `npm start`
7. Setelah tertaut, gunakan PM2: `pm2 start ecosystem.config.cjs && pm2 save`

Jangan hapus folder `auth` setelah pairing berhasil.
