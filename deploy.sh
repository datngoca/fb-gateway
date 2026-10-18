#!/bin/bash
set -e

echo "=== [1/4] Kiểm tra Node.js ==="
if ! command -v node &> /dev/null; then
    echo "Node.js chưa được cài đặt. Vui lòng cài đặt Node.js 18+ trước."
    exit 1
fi

echo "=== [2/4] Cài đặt thư viện npm ==="
npm install --production

echo "=== [3/4] Cài đặt PM2 (nếu chưa có) ==="
if ! command -v pm2 &> /dev/null; then
    sudo npm install -g pm2
fi

echo "=== [4/4] Khởi động ứng dụng với giới hạn RAM ==="
if [ ! -f .env ]; then
    cp .env.example .env
fi

pm2 delete fb-gateway 2>/dev/null || true
pm2 start ecosystem.config.js
pm2 save

echo "============================================="
echo " FB-GATEWAY ĐÃ ĐƯỢC TRIỂN KHAI THÀNH CÔNG!"
echo " Kiểm tra trạng thái: pm2 status fb-gateway"
echo " Kiểm tra log: pm2 logs fb-gateway"
echo "============================================="
