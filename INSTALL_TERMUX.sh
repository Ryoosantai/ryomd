#!/data/data/com.termux/files/usr/bin/bash
set -e
pkg update -y
pkg install -y nodejs ffmpeg git
npm install
[ -f .env ] || cp .env.example .env
node --check index.js
echo 'Ryo siap dijalankan: npm start'
