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

// Human-like delays to avoid bot detection
function randomDelay(min, max){ return Math.floor(Math.random() * (max - min + 1)) + min; }
async function humanDelay(page, minMs=500, maxMs=1500){
  const delay = randomDelay(minMs, maxMs);
  console.log(`Aguardando ${delay}ms (comportamento humano)...`);
  await page.waitForTimeout(delay);
}
async function typeHumanLike(field, text, page){
  await field.click();
  await page.waitForTimeout(randomDelay(100, 300));
  for(const char of text){
    await field.type(char, { delay: randomDelay(50, 150) });
  }
  await page.waitForTimeout(randomDelay(200, 500));
}

async function fillFirstVisible(scope, sels, val, page){
  for(const sel of sels){
    const list = scope.locator(sel);
    const n = await list.count();
    for(let i=0;i<n;i++){
      const el = list.nth(i);
      if(await el.isVisible().catch(()=>false)){
        await typeHumanLike(el, val, page);
        return true;
      }
    }
  } return false;
}
async function tryFillByLabel(scope, rx, val, page){
  const loc = scope.getByLabel(rx).first();
  if((await loc.count()) && await loc.isVisible().catch(()=>false)){
    await typeHumanLike(loc, val, page);
    return true;
  }
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
  // First check for cookie error message
  const cookieError = await page.locator('text=/cookie.*not.*found/i, text=/sentimos.*muito/i, text=/make.*sure.*cookies.*enabled/i').first().count();
  if(cookieError > 0){
    console.error('ERRO: Página de erro de cookies detectada!');
    return false;
  }

  // Check if still on login page
  if(await findLoginContext(page)){
    console.log('Ainda na página de login');
    return false;
  }

  // Check if still on 2FA page
  if(await findOtpContext(page)){
    console.log('Ainda na página 2FA');
    return false;
  }

  // Additional check: make sure we're not on an error page
  const errorIndicators = await page.locator('text=/erro/i, text=/error/i, text=/acesso.*negado/i, text=/access.*denied/i').count();
  if(errorIndicators > 0){
    console.warn('Possível página de erro detectada');
    return false;
  }

  console.log('Verificação: parece estar autenticado');
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
  const found = await findOtpContext(page);
  if(!found) {
    console.log('Nenhum campo 2FA encontrado - pode já estar autenticado');
    return;
  }
  const { ctx, otpField } = found;

  console.log('Campo 2FA encontrado, tentando preencher código TOTP...');

  // Human delay before starting 2FA
  await humanDelay(page, 1000, 2000);

  for(let attempt=1; attempt<=TOTP_TRIES; attempt++){
    console.log(`Tentativa 2FA ${attempt}/${TOTP_TRIES}`);

    const code = getTotp();
    console.log(`Código TOTP gerado: ${code}`);

    // Human delay before typing code
    await humanDelay(page, 500, 1000);

    // Try to find the OTP field - could be #otp or other selectors
    const field = ctx.locator('#otp').first();
    const fieldExists = await field.count() > 0;

    if(fieldExists){
      await field.waitFor({ state: 'visible', timeout: 5000 }).catch(()=>{});
      await typeHumanLike(field, code, page);
      console.log('Código 2FA preenchido');
    } else {
      // Fallback to the otpField found by findOtpContext
      await typeHumanLike(otpField, code, page);
      console.log('Código 2FA preenchido (campo alternativo)');
    }

    // Human delay before clicking submit
    await humanDelay(page, 800, 1500);

    // Click submit button or press Enter
    const clicked = await clickIfExists(ctx,/entrar|confirmar|continuar|verificar|submit/i);
    if(!clicked) await ctx.keyboard.press('Enter');

    // Wait for navigation with extra time
    console.log('Aguardando validação do código 2FA...');
    await page.waitForLoadState('networkidle',{timeout:12000}).then(()=>true).catch(()=>false);
    await humanDelay(page, 2000, 3000);

    // Check if we're authenticated now
    if(await isFullyAuthenticated(page)){
      console.log('2FA aceito! Autenticado com sucesso.');
      return;
    }

    // Check for error message
    const erro = await ctx.locator('text=/c[oó]digo.*inv[aá]lido/i').first().count();
    if(erro){
      console.warn(`Tentativa ${attempt} falhou - código inválido`);
      // Wait for next TOTP cycle if not the last attempt
      if(attempt < TOTP_TRIES){
        const waitTime = msToNextStep();
        console.log(`Aguardando ${Math.ceil(waitTime/1000)}s para próximo código...`);
        await page.waitForTimeout(waitTime);
      }
      continue;
    }

    // If no error but still not authenticated, might need more time
    console.log('Aguardando mais tempo para verificar 2FA...');
    await page.waitForTimeout(2000);
    if(await isFullyAuthenticated(page)){
      console.log('2FA aceito! Autenticado com sucesso.');
      return;
    }
  }

  console.error('2FA falhou após várias tentativas');
  throw new Error('2FA falhou após várias tentativas. Revise TOTP_SECRET/hora/TOTP_OFFSET_MS.');
}

async function performLogin(page){
  if(!BASE_URL) throw new Error('BASE_URL não configurada no .env');
  console.log('Abrindo página de login...');
  await page.goto(BASE_URL,{waitUntil:'domcontentloaded'});

  // Wait for page to fully load with human-like delay
  console.log('Aguardando página carregar completamente...');
  await humanDelay(page, 2000, 3000);

  // Verify cookies are being set
  const cookies = await page.context().cookies();
  console.log(`Cookies encontrados: ${cookies.length}`);
  if(cookies.length === 0){
    console.warn('Nenhum cookie definido ainda. Aguardando mais tempo...');
    await humanDelay(page, 2000, 3000);
  }

  for(let round=1; round<=3; round++){
    console.log(`Tentativa de login ${round}/3`);

    // Wait before checking for login form
    await humanDelay(page, 500, 1000);

    const ctx = await findLoginContext(page);
    if(ctx){
      console.log('Formulário de login encontrado, preenchendo credenciais...');

      // Human delay before starting to type
      await humanDelay(page, 800, 1500);

      const userOk =
        await tryFillByLabel(ctx,/usu[aá]rio/i,process.env.EPROC_USERNAME, page) ||
        await fillFirstVisible(ctx,[
          'input[name="username"]:not([type="hidden"]):visible',
          '#username:visible','input[autocomplete="username"]',
          'input[aria-label*="usu" i]:visible','input[placeholder*="usu" i]:visible',
          'input[type="text"]:visible'
        ], process.env.EPROC_USERNAME, page);
      if(!userOk){
        console.error('Campo de usuário não encontrado/visível.');
        throw new Error('Campo de usuário não encontrado/visível.');
      }
      console.log('Usuário preenchido');

      // Human delay between username and password
      await humanDelay(page, 600, 1200);
      await ctx.keyboard.press('Tab');
      await page.waitForTimeout(randomDelay(300, 600));

      const passOk =
        await tryFillByLabel(ctx,/senha/i,process.env.EPROC_PASSWORD, page) ||
        await fillFirstVisible(ctx,[
          'input[type="password"]:not([autocomplete="one-time-code"]):visible',
          'input[name="password"]:not([autocomplete="one-time-code"]):visible',
          'input[autocomplete="current-password"]',
          'input[aria-label*="senh" i]:visible','input[placeholder*="senh" i]:visible'
        ], process.env.EPROC_PASSWORD, page);
      if(!passOk){
        console.error('Campo de senha não encontrado/visível.');
        throw new Error('Campo de senha não encontrado/visível.');
      }
      console.log('Senha preenchida');

      // Human delay before clicking submit
      await humanDelay(page, 800, 1500);

      const clicked = await clickIfExists(ctx,/entrar|acessar|login|continuar/i) || await clickIfExists(ctx,'button[type="submit"]');
      if(!clicked){
        console.log('Botão de login não encontrado, pressionando Enter');
        await ctx.keyboard.press('Enter');
      } else {
        console.log('Botão de login clicado');
      }

      // Wait for navigation with extra time
      console.log('Aguardando navegação após login...');
      await page.waitForLoadState('networkidle',{timeout:20000}).catch(()=>{});
      await humanDelay(page, 2000, 3000);
    } else {
      console.log('Nenhum formulário de login visível nesta página');
    }

    // Take screenshot after login attempt
    await ensureDir('out');
    await page.screenshot({ path: path.join('out',`apos-login-tentativa-${round}.png`), fullPage:true });
    console.log(`Screenshot salvo: out/apos-login-tentativa-${round}.png`);

    // Try to solve 2FA if it appears
    await solve2FA(page);

    // Take screenshot after 2FA
    await page.screenshot({ path: path.join('out',`apos-2fa-tentativa-${round}.png`), fullPage:true });
    console.log(`Screenshot salvo: out/apos-2fa-tentativa-${round}.png`);

    // Check if we're fully authenticated now
    if(await isFullyAuthenticated(page)){
      await ensureDir('auth');
      await page.context().storageState({ path: path.join('auth','auth-state.json') });
      console.log('Login concluído com sucesso! Sessão salva em auth/auth-state.json');

      // Take screenshot of logged-in page for debugging
      await ensureDir('out');
      await page.screenshot({ path: path.join('out','login-sucesso.png'), fullPage:true });
      console.log('Screenshot da página logada salva em out/login-sucesso.png');

      return;
    }

    // If not authenticated yet, wait a bit and try again
    if(round < 3){
      console.log('Ainda não autenticado, aguardando antes da próxima tentativa...');
      await page.waitForTimeout(2000);
    }
  }

  // If we got here, all attempts failed
  console.error('Falha na autenticação após 3 tentativas');
  await ensureDir('out');
  await page.screenshot({ path: 'out/login-falhou.png', fullPage:true }).catch(()=>{});
  throw new Error('Não consegui autenticar. Veja out/login-falhou.png');
}

async function gotoPrazos(page){
  console.log('Indo para "Prazos"...');

  // Take screenshot before trying to navigate
  await ensureDir('out');
  await page.screenshot({ path: path.join('out','antes-prazos.png'), fullPage:true });
  console.log('Screenshot da página antes de buscar Prazos salva em out/antes-prazos.png');

  // Wait a bit for page to fully load
  await page.waitForTimeout(2000);

  if(!(await isFullyAuthenticated(page))) {
    console.error('Ainda em tela de login/2FA');
    await page.screenshot({ path: path.join('out','still-in-login.png'), fullPage:true });
    throw new Error('Ainda em login/2FA. Autentique antes de navegar.');
  }

  console.log('Procurando campo de pesquisa...');
  let search = page.getByPlaceholder(/Pesquisar/i).first();
  if(!await search.count()){
    console.log('Campo de pesquisa não encontrado na página principal, procurando em frames...');
    for(const f of page.frames()){
      const s=f.getByPlaceholder(/Pesquisar/i).first();
      if(await s.count()){
        search=s;
        console.log('Campo de pesquisa encontrado em frame');
        break;
      }
    }
  } else {
    console.log('Campo de pesquisa encontrado na página principal');
  }

  if(await search.count()){
    console.log('Tentando buscar por "prazos" usando o campo de pesquisa...');
    await search.click();
    await search.fill('prazos');
    await page.waitForTimeout(700);

    let ok=false; const scopes=[page, ...page.frames()];
    for(const sc of scopes){
      ok = await sc.getByRole('link',{name:/prazos/i}).first().click().then(()=>true).catch(()=>false);
      if(ok) {
        console.log('Link de Prazos clicado (por role=link)');
        break;
      }
      ok = await sc.getByText(/prazos/i,{exact:false}).first().click().then(()=>true).catch(()=>false);
      if(ok) {
        console.log('Link de Prazos clicado (por texto)');
        break;
      }
    }
    if(!ok) {
      console.log('Nenhum link encontrado, pressionando Enter no campo de pesquisa');
      await search.press('Enter');
    }
  } else {
    console.log('Campo de pesquisa não encontrado, procurando link direto de Prazos...');
    const scopes=[page, ...page.frames()];
    let clicked=false;
    for(const sc of scopes){
      clicked = await sc.getByText(/Prazos/i).first().click().then(()=>true).catch(()=>false);
      if(clicked) {
        console.log('Link direto de Prazos encontrado e clicado');
        break;
      }
    }
    if(!clicked) {
      console.error('Não consegui encontrar Prazos de nenhuma forma');
      await page.screenshot({ path: path.join('out','prazos-nao-encontrado.png'), fullPage:true });
      console.log('Screenshot salvo em out/prazos-nao-encontrado.png');

      // Log current URL and page title for debugging
      console.log('URL atual:', page.url());
      const title = await page.title();
      console.log('Título da página:', title);

      throw new Error('Não achei "Pesquisar no Menu" nem item direto de Prazos. Veja out/prazos-nao-encontrado.png');
    }
  }

  await page.waitForLoadState('networkidle').catch(()=>{});
  await page.waitForTimeout(1000);
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
