# ePROC Scraper

Scraper automatizado para o sistema ePROC (Processo Judicial Eletrônico) usado por advogados no Brasil.

## O que foi corrigido?

### Problema de Cookies
O erro "Cookie not found. Please make sure cookies are enabled in your browser" foi resolvido com as seguintes melhorias:

1. **User Agent realista**: Mudado de `EPROC-Scraper/0.1 (Playwright)` para um User Agent real do Chrome
2. **Configuração de localização**: Adicionado `locale: 'pt-BR'` e `timezoneId: 'America/Sao_Paulo'`
3. **Headers HTTP**: Adicionado `Accept-Language: pt-BR`
4. **Remoção de flags problemáticas**: Removidos flags que desabilitavam cookies desnecessariamente
5. **Verificação de cookies**: Adicionada verificação após carregar a página para garantir que cookies foram definidos
6. **Navegação otimizada**: Removida navegação duplicada que poderia causar problemas com cookies

## Como Usar

### 1. Instalar Dependências

```bash
npm install
```

### 2. Configurar Credenciais

Copie o arquivo `.env.example` para `.env`:

```bash
cp .env.example .env
```

Edite o arquivo `.env` e preencha com suas informações:

```env
BASE_URL=https://eproc.jfes.jus.br/eproc/
EPROC_USERNAME=seu_usuario
EPROC_PASSWORD=sua_senha
TOTP_SECRET=seu_segredo_totp
HEADLESS=false
```

**Importante**:
- `TOTP_SECRET`: Este é o código secreto do seu autenticador 2FA (Google Authenticator, Authy, etc.)
- `HEADLESS=false`: Mantenha como `false` para ver o navegador abrindo (útil para debug)
- `HEADLESS=true`: Use quando quiser rodar em background (para n8n, por exemplo)

### 3. Rodar o Scraper

```bash
npm start
```

ou em modo debug:

```bash
npm run debug
```

## Estrutura do Projeto

- `index.js` - Script principal do scraper
- `get-totp.js` - Gerador de códigos TOTP (2FA)
- `totp-skew.js` - Utilitário para testar sincronização de tempo
- `totp-check.js` - Utilitário para verificar códigos TOTP
- `out/` - Pasta onde são salvos screenshots e logs
- `.env` - Suas configurações (NÃO commitar!)

## Como Funciona

1. **Login**: Abre a página do ePROC e faz login com usuário/senha
2. **2FA**: Gera automaticamente o código TOTP e preenche
3. **Navegação**: Navega até a seção "Prazos"
4. **Screenshots**: Salva screenshots em cada etapa importante

## Troubleshooting

### Erro de Cookies
Se você ainda ver o erro de cookies:
- Certifique-se de que o `BASE_URL` está correto
- Verifique se sua conexão de internet está estável
- Tente com `HEADLESS=false` para ver o que está acontecendo

### Erro de 2FA
Se o código 2FA não funcionar:
- Verifique se o `TOTP_SECRET` está correto
- Sincronize o relógio do seu sistema
- Ajuste o `TOTP_OFFSET_MS` se necessário

### Erro de Login
Se não conseguir fazer login:
- Verifique usuário e senha no `.env`
- Certifique-se de que sua conta não está bloqueada
- Tente fazer login manual primeiro

## Para n8n

Quando integrar com n8n:
1. Configure `HEADLESS=true` no `.env`
2. Use o node "Execute Command" no n8n
3. Comando: `cd /caminho/para/eproc-scrapers && npm start`
4. Parse os resultados dos screenshots ou logs conforme necessário

## Segurança

**NUNCA** faça commit do arquivo `.env` com suas credenciais!
O `.gitignore` já está configurado para ignorar este arquivo.
