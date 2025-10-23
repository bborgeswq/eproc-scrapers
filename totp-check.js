require('dotenv').config();
const { authenticator } = require('otplib');

const PERIOD = Number(process.env.TOTP_PERIOD || 30);
const DIGITS = Number(process.env.TOTP_DIGITS || 6);
authenticator.options = { step: PERIOD, digits: DIGITS };

const secret = (process.env.TOTP_SECRET || '').replace(/\s+/g,'').trim();
if (!secret) { console.error('Defina TOTP_SECRET no .env'); process.exit(1); }

function secsLeft() {
  const step = PERIOD * 1000;
  return Math.ceil((step - (Date.now() % step)) / 1000);
}

function show() {
  const code = authenticator.generate(secret);
  process.stdout.write(`\rTOTP ${PERIOD}s: ${code}  | expira em ~${secsLeft()}s   `);
}
show();
setInterval(show, 400);
