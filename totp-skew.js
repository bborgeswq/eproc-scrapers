require('dotenv').config();
const { authenticator } = require('otplib');
const PERIOD = Number(process.env.TOTP_PERIOD || 30);
const DIGITS = Number(process.env.TOTP_DIGITS || 6);
const OFFSET = Number(process.env.TOTP_OFFSET_MS || 0);
authenticator.options = { step: PERIOD, digits: DIGITS };

const secret = (process.env.TOTP_SECRET || '').replace(/\s+/g,'').trim();
if (!secret) { console.error('Defina TOTP_SECRET no .env'); process.exit(1); }

function epoch(stepOffset=0){
  const stepMs = PERIOD*1000;
  const curStep = Math.floor((Date.now()+OFFSET)/stepMs);
  return (curStep + stepOffset) * stepMs;
}
function secsLeft(){ const step=PERIOD*1000; return Math.ceil((step - ((Date.now()+OFFSET) % step))/1000); }

function show(){
  const prev = authenticator.generate(secret, { epoch: epoch(-1) });
  const curr = authenticator.generate(secret, { epoch: epoch(0) });
  const next = authenticator.generate(secret, { epoch: epoch(+1) });
  process.stdout.write(`\rPrev: ${prev} | Curr: ${curr} | Next: ${next} | expira em ~${secsLeft()}s   `);
}
show(); setInterval(show, 400);
