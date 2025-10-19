// generateVapid.js
const fs = require('fs');
const webpush = require('web-push');
const x = require("mysql2/promise");

const vapidKeys = webpush.generateVAPIDKeys();

const data = JSON.stringify({
  publicKey: vapidKeys.publicKey,
  privateKey: vapidKeys.privateKey
}, null, 2);

fs.writeFileSync('waffitv-vapidkey.json', data);

console.log('✅ VAPID keys generated and saved to vapidkey.json');
console.log('Public Key:', vapidKeys.publicKey);
console.log('Private Key:', vapidKeys.privateKey);