# Barbearia do Juan — site + agendamento online

HTML, CSS e JavaScript puro (sem frameworks). Duas formas de rodar, com o **mesmo** frontend:

| Modo | Quando usar | Banco |
|---|---|---|
| **Servidor local** (`server.js`) | testar no seu computador / hospedar num servidor Node | SQLite em `data/barbearia.db` |
| **Supabase** | hospedagem estática (Netlify, GitHub Pages, etc.) | PostgreSQL do Supabase |

## Rodar localmente

Requer Node 22.5+ (sem `npm install`, sem dependências).

```
node server.js
```

- Site: http://localhost:8080 · Agendamento: `/agendamento.html` · Painel: http://localhost:8080/admin
- Na **primeira execução** é criado o usuário `admin` e a senha aparece no terminal. Para definir a sua:
  `node server.js --set-password SUA_SENHA` (ou `ADMIN_PASSWORD=... node server.js` na primeira vez).
- Porta: `PORT=3000 node server.js`.

## Usar o Supabase (hospedagem estática)

1. Crie um projeto em supabase.com → **SQL Editor** → cole e rode [supabase/schema.sql](supabase/schema.sql).
2. **Authentication → Users → Add user** (e-mail e senha do Juan). Depois rode no SQL Editor:
   `insert into usuarios_admin (user_id, email) select id, email from auth.users where email = 'EMAIL_DO_JUAN';`
3. Em **Project Settings → API**, copie a *Project URL* e a chave **anon public** para [js/config.js](js/config.js).
   (Nunca use a chave `service_role` no site.)
4. Publique a pasta como site estático. O login do painel passa a usar e-mail + senha do Supabase.

## Como a segurança e a dupla reserva funcionam

- O navegador só **mostra** horários. Quem decide é o backend: `POST /api/agendar` (local) ou a função SQL `criar_agendamento` (Supabase) recalcula **serviços, preço, duração, expediente, almoço, bloqueios e conflito** e ignora qualquer valor enviado pelo navegador.
- Local: a validação e a gravação acontecem numa transação `BEGIN IMMEDIATE`. Supabase: trava (`pg_advisory_xact_lock`) por dia **e** uma restrição `EXCLUDE` no banco que recusa agendamentos sobrepostos — mesmo que duas requisições cheguem juntas.
- Se o horário foi tomado, o cliente vê “Este horário acabou de ser reservado. Escolha outro horário.” e a lista é atualizada.
- Visitantes não leem clientes, agendamentos nem bloqueios (RLS no Supabase; rotas com token no servidor local). O painel exige login.

## Regras de negócio

- Horários são calculados a partir de: expediente por dia da semana, almoço, bloqueios, agendamentos existentes e a **duração total** dos serviços escolhidos (o atendimento inteiro precisa caber).
- **Combos**: se o cliente marca todos os serviços de um combo ativo, vale o preço/duração do combo (Corte + Barba = R$ 70 / 70 min). Novos combos são cadastrados no painel.
- Serviço sem preço aparece como **“Sob consulta”**; o preço de qualquer serviço se altera em *Serviços* no painel.

## Painel (`/admin`)

Dashboard · Agendamentos (calendário, detalhes, cancelar) · Serviços · Combos · Horários (dias, almoço, regras) · Bloqueios (vários por dia, dia inteiro) · Galeria · Configurações (dados, textos, logo, fotos).

## Crédito no rodapé

Para o link do LinkedIn, preencha `linkedinUrl` em [js/config.js](js/config.js).

## Fotos

As imagens de `assets/images/` vêm da folha `docs/imagensSite.png` (serviços, combo, galeria, sobre e fundo do “Agende seu horário”). Só a foto principal do início (`hero.jpg`) ainda é um recorte do mockup, de menor resolução. Para trocar qualquer foto, substitua o arquivo mantendo o nome, ou use o painel (Serviços, Combos, Galeria, Configurações). Fotos enviadas pelo painel são reduzidas e guardadas no banco.

## Estrutura

```
index.html · agendamento.html · admin.html
css/  style.css · agendamento.css · admin.css
js/   config.js · availability.js · services.js · icons.js · app.js · agendamento.js · admin.js
assets/images · assets/logo
server.js            servidor local (API + SQLite)
supabase/schema.sql  banco para o Supabase
```

`js/availability.js` é usado pelo navegador e pelo `server.js` (mesma regra dos dois lados).
