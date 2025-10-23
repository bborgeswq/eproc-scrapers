require('dotenv').config();
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')()
const { authenticator } = require('otplib');
const fs = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { getTotp } = require('./get-totp');

chromium.use(stealth)

const BASE_URL    = process.env.BASE_URL;
const HEADLESS    = (process.env.HEADLESS || 'true').toLowerCase() === 'true';
const FORCE_LOGIN = (process.env.FORCE_LOGIN || 'false').toLowerCase() === 'true';

const TOTP_PERIOD    = Number(process.env.TOTP_PERIOD || 30);
const TOTP_DIGITS    = Number(process.env.TOTP_DIGITS || 6);
const TOTP_TRIES     = Number(process.env.TOTP_TRIES || 4);
const TOTP_SKEW      = Number(process.env.TOTP_SKEW_STEPS || 1);   // tenta -1..+1
const TOTP_OFFSET_MS = Number(process.env.TOTP_OFFSET_MS || 0);    // ajuste fino

authenticator.options = { step: TOTP_PERIOD, digits: TOTP_DIGITS };

async function ensureDir(p){ await fs.mkdir(p,{recursive:true}).catch(()=>{}); }
function ask(q){ const rl=readline.createInterface({input:process.stdin,output:process.stdout}); return new Promise(r=>rl.question(q,a=>{rl.close(); r(a.trim());})); }

async function fillFirstVisible(scope, sels, val){
  for(const sel of sels){
    const list = scope.locator(sel);
    const n = await list.count();
    for(let i=0;i<n;i++){
      const el = list.nth(i);
      if(await el.isVisible().catch(()=>false)){ await el.fill(val); return true; }
    }
  } return false;
}
async function tryFillByLabel(scope, rx, val){
  const loc = scope.getByLabel(rx).first();
  if((await loc.count()) && await loc.isVisible().catch(()=>false)){ await loc.fill(val); return true; }
  return false;
}
async function clickIfExists(scope, selOrRx){
  if(typeof selOrRx==='string'){
    const el = scope.locator(selOrRx).first();
    if(await el.count()){ await el.click(); return true; }
  } else {
    const btn = scope.getByRole('button',{name:selOrRx}).first();
    if(await btn.count()){ await btn.click(); return true; }
  }
  return false;
}

async function findLoginContext(page){
  const scopes = [page, ...page.frames()];
  for(const sc of scopes){
    const hasUser  = await sc.locator('input[name="username"]:visible, #username:visible, input[type="text"]:visible').first().count();
    const hasPass  = await sc.locator('input[type="password"]:visible').first().count();
    const lblUser  = await sc.getByLabel(/usu[aá]rio/i).first().count();
    const lblPass  = await sc.getByLabel(/senha/i).first().count();
    if((hasUser && hasPass) || lblUser || lblPass) return sc;
  } return null;
}
async function findOtpContext(page){
  const scopes = [page, ...page.frames()];
  for(const sc of scopes){
    const otp = sc.locator('input[name*="otp" i]:visible, input[name*="totp" i]:visible, input[name*="token" i]:visible, input[autocomplete="one-time-code"]:visible, input[type="tel"]:visible, input[type="text"]:visible').first();
    if(await otp.count()) return { ctx: sc, otpField: otp };
  } return null;
}
async function isFullyAuthenticated(page){
  if(await findLoginContext(page)) return false;
  if(await findOtpContext(page))   return false;
  return true;
}

function stepNow(){ return Math.floor((Date.now() + TOTP_OFFSET_MS) / (TOTP_PERIOD * 1000)); }
function secondsLeft(){
  const step = TOTP_PERIOD*1000;
  return Math.ceil((step - ((Date.now() + TOTP_OFFSET_MS) % step)) / 1000);
}
function msToNextStep(){ const step=TOTP_PERIOD*1000; const remain=step - ((Date.now() + TOTP_OFFSET_MS) % step); return remain + 200; }
function genTotp(secret, stepOffset=0){
  const base = (stepNow() + stepOffset) * (TOTP_PERIOD*1000);
  return authenticator.generate(secret, { epoch: base });
}

async function solve2FA(page){
  const found = await findOtpContext(page); if(!found) return;
  const { ctx, otpField } = found;

  for(let attempt=1; attempt<=TOTP_TRIES; attempt++){

    const code = getTotp()
      //debugger;
      // for(const code of codes){
      //await otpField.fill(code);
      //

      // input id #otp
      // get element by input id
      // then fill it with code
      const field = ctx.locator('#otp').first();

        await field.waitFor({ state: 'visible', timeout: 5000 });
        await field.fill(code);

      await (clickIfExists(ctx,/entrar|confirmar|continuar|verificar|submit/i) || ctx.keyboard.press('Enter'));

         // page.wait
         debugger;
      // debugger;
      const ok = await page.waitForLoadState('networkidle',{timeout:4000}).then(()=>true).catch(()=>false);


      return;
      // debugger;

      // if(ok && await isFullyAuthenticated(page)){ accepted = true; break; }

      //const erro = await ctx.locator('text=/c[oó]digo.*inv[aá]lido/i').first().count();
      //if(erro){ await otpField.click().catch(()=>{}); continue; }

      // debugger;
      //if(await isFullyAuthenticated(page)){ accepted = true; break; }
    // }

   // if(accepted) return;
   // await ctx.waitForTimeout(msToNextStep());
  }
  //throw new Error('2FA falhou após várias tentativas. Revise TOTP_SECRET/hora/TOTP_OFFSET_MS.');
}

async function performLogin(page){
  if(!BASE_URL) throw new Error('BASE_URL não configurada no .env');
  console.log('Abrindo página de login...');
  await page.goto(BASE_URL,{waitUntil:'domcontentloaded'});

  // Wait a bit for cookies to be set
  await page.waitForTimeout(1000);

  // Verify cookies are being set
  const cookies = await page.context().cookies();
  console.log(`Cookies encontrados: ${cookies.length}`);
  if(cookies.length === 0){
    console.warn('Nenhum cookie definido ainda. Aguardando mais tempo...');
    await page.waitForTimeout(2000);
  }

  for(let round=1; round<=3; round++){
    const ctx = await findLoginContext(page);
    if(ctx){
      const userOk =
        await tryFillByLabel(ctx,/usu[aá]rio/i,process.env.EPROC_USERNAME) ||
        await fillFirstVisible(ctx,[
          'input[name="username"]:not([type="hidden"]):visible',
          '#username:visible','input[autocomplete="username"]',
          'input[aria-label*="usu" i]:visible','input[placeholder*="usu" i]:visible',
          'input[type="text"]:visible'
        ], process.env.EPROC_USERNAME);
      if(!userOk) throw new Error('Campo de usuário não encontrado/visível.');

      await ctx.keyboard.press('Tab'); await page.waitForTimeout(150);

      const passOk =
        await tryFillByLabel(ctx,/senha/i,process.env.EPROC_PASSWORD) ||
        await fillFirstVisible(ctx,[
          'input[type="password"]:not([autocomplete="one-time-code"]):visible',
          'input[name="password"]:not([autocomplete="one-time-code"]):visible',
          'input[autocomplete="current-password"]',
          'input[aria-label*="senh" i]:visible','input[placeholder*="senh" i]:visible'
        ], process.env.EPROC_PASSWORD);
      if(!passOk) throw new Error('Campo de senha não encontrado/visível.');

      const clicked = await clickIfExists(ctx,/entrar|acessar|login|continuar/i) || await clickIfExists(ctx,'button[type="submit"]');
      if(!clicked) await ctx.keyboard.press('Enter');
      await page.waitForLoadState('networkidle',{timeout:15000}).catch(()=>{});
    }

    // debugger;
    await solve2FA(page);
    // if(await isFullyAuthenticated(page)){
      // await ensureDir('auth');
      // await page.context().storageState({ path: path.join('auth','auth-state.json') });
      // console.log('Login concluído e sessão salva em auth/auth-state.json');
      //return;
    // }
  }

  await ensureDir('out');
  await page.screenshot({ path: 'out/login-falhou.png', fullPage:true }).catch(()=>{});
  throw new Error('Não consegui autenticar. Veja out/login-falhou.png');
}

async function gotoPrazos(page){
  console.log('Indo para "Prazos"...');
  if(!(await isFullyAuthenticated(page))) throw new Error('Ainda em login/2FA. Autentique antes de navegar.');

  let search = page.getByPlaceholder(/Pesquisar/i).first();
  if(!await search.count()){
    for(const f of page.frames()){
      const s=f.getByPlaceholder(/Pesquisar/i).first();
      if(await s.count()){ search=s; break; }
    }
  }

  if(await search.count()){
    await search.click(); await search.fill('prazos'); await page.waitForTimeout(700);

    let ok=false; const scopes=[page, ...page.frames()];
    for(const sc of scopes){
      ok = await sc.getByRole('link',{name:/prazos/i}).first().click().then(()=>true).catch(()=>false);
      if(ok) break;
      ok = await sc.getByText(/prazos/i,{exact:false}).first().click().then(()=>true).catch(()=>false);
      if(ok) break;
    }
    if(!ok) await search.press('Enter');
  } else {
    const scopes=[page, ...page.frames()];
    let clicked=false;
    for(const sc of scopes){
      clicked = await sc.getByText(/Prazos/i).first().click().then(()=>true).catch(()=>false);
      if(clicked) break;
    }
    if(!clicked) throw new Error('Não achei "Pesquisar no Menu" nem item direto de Prazos.');
  }

  await page.waitForLoadState('networkidle');
  await ensureDir('out');
  await page.screenshot({ path: path.join('out','prazos-landing.png'), fullPage:true });
  console.log('Tela de Prazos aberta. Screenshot em out/prazos-landing.png');
}

async function main(){
  await ensureDir('out');
  const browser = await chromium.launch({
    headless: HEADLESS,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox'
    ]
  });

  const reuse = false;// !FORCE_LOGIN && await fs.stat(path.join('auth','auth-state.json')).catch(()=>null);

  const context = await browser.newContext({
    acceptDownloads: true,
    // se existir, reaproveita sessão logada
    // storageState: hasState ? storageStatePath : undefined,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 850 },
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
    // Ensure cookies, localStorage, and sessionStorage are enabled
    storageState: undefined,
    // Enable JavaScript (should be on by default, but making it explicit)
    javaScriptEnabled: true,
    // Accept all cookies
    bypassCSP: false,
    // Extra HTTP headers
    extraHTTPHeaders: {
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
    }
  });
  const page = await context.newPage();

  try{
    // Don't navigate here - let performLogin handle the first navigation
    // This avoids potential cookie issues from multiple navigations
    console.log('Iniciando login...');
    await performLogin(page);

    debugger;

    await gotoPrazos(page);

    console.log('Etapa 1 finalizada com sucesso.');
    if(HEADLESS) await browser.close();
    else console.log('Browser ficou aberto (HEADLESS=false). Feche quando quiser.');
  } catch(err){
    console.error('Falha:', err.message);
    try{ await page.screenshot({ path: path.join('out','error.png'), fullPage:true }); console.error('Screenshot de erro salvo em out/error.png'); }catch{}
    await browser.close();
    process.exit(1);
  }
}

main();
