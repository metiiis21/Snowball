import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 4173);
const T_BASE = 'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1';

app.use(express.json());

function token() {
  const value = process.env.T_INVEST_TOKEN;
  if (!value) {
    const err = new Error('T_INVEST_TOKEN не задан на сервере');
    err.status = 503;
    throw err;
  }
  return value;
}

async function tCall(service, method, body = {}) {
  const res = await fetch(`${T_BASE}.${service}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!res.ok) {
    const err = new Error(data?.message || data?.error || `T-Invest API: HTTP ${res.status}`);
    err.status = res.status;
    err.trackingId = res.headers.get('x-tracking-id');
    throw err;
  }
  return data;
}

const money = (v) => v ? Number(v.units || 0) + Number(v.nano || 0) / 1e9 : 0;
const quote = money;

app.get('/api/tinvest/status', (req, res) => {
  res.json({ configured: Boolean(process.env.T_INVEST_TOKEN) });
});

app.get('/api/tinvest/accounts', async (req, res, next) => {
  try {
    const data = await tCall('UsersService', 'GetAccounts', { status: 'ACCOUNT_STATUS_OPEN' });
    res.json({ accounts: data.accounts || [] });
  } catch (e) { next(e); }
});

app.get('/api/tinvest/portfolio/:accountId', async (req, res, next) => {
  try {
    const p = await tCall('OperationsService', 'GetPortfolio', { accountId: req.params.accountId, currency: 'RUB' });
    const rawPositions = p.positions || [];
    const enriched = await Promise.all(rawPositions.map(async (x) => {
      const uid = x.instrumentUid || x.positionUid || x.figi;
      let instrument = null;
      if (uid) {
        try {
          const info = await tCall('InstrumentsService', 'GetInstrumentBy', {
            idType: x.instrumentUid ? 'INSTRUMENT_ID_TYPE_UID' : (x.positionUid ? 'INSTRUMENT_ID_TYPE_POSITION_UID' : 'INSTRUMENT_ID_TYPE_FIGI'),
            id: uid
          });
          instrument = info.instrument || null;
        } catch { /* position still remains usable */ }
      }
      return {
        figi: x.figi,
        instrumentUid: x.instrumentUid,
        positionUid: x.positionUid,
        instrumentType: x.instrumentType,
        quantity: quote(x.quantity),
        averagePrice: money(x.averagePositionPrice),
        currentPrice: money(x.currentPrice),
        expectedYield: quote(x.expectedYield),
        currentNkd: money(x.currentNkd),
        ticker: instrument?.ticker || x.figi || uid || '—',
        name: instrument?.name || instrument?.ticker || x.figi || 'Инструмент',
        isin: instrument?.isin || '',
        currency: instrument?.currency || x.currentPrice?.currency || 'rub'
      };
    }));
    res.json({
      accountId: p.accountId || req.params.accountId,
      total: money(p.totalAmountPortfolio),
      shares: money(p.totalAmountShares),
      bonds: money(p.totalAmountBonds),
      etf: money(p.totalAmountEtf),
      currencies: money(p.totalAmountCurrencies),
      futures: money(p.totalAmountFutures),
      expectedYield: quote(p.expectedYield),
      dailyYield: money(p.dailyYield),
      dailyYieldRelative: quote(p.dailyYieldRelative),
      positions: enriched
    });
  } catch (e) { next(e); }
});

app.get('/api/tinvest/sync', async (req, res, next) => {
  try {
    const a = await tCall('UsersService', 'GetAccounts', { status: 'ACCOUNT_STATUS_OPEN' });
    const accounts = a.accounts || [];
    const portfolios = await Promise.all(accounts.map(async (account) => {
      const pRes = await fetch(`http://127.0.0.1:${PORT}/api/tinvest/portfolio/${encodeURIComponent(account.id)}`);
      if (!pRes.ok) return { accountId: account.id, error: true };
      return pRes.json();
    }));
    res.json({ accounts, portfolios, syncedAt: new Date().toISOString() });
  } catch (e) { next(e); }
});

app.use((err, req, res, next) => {
  const status = Number(err.status) || 500;
  res.status(status).json({ error: err.message || 'Ошибка сервера', trackingId: err.trackingId || undefined });
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
} else {
  const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Мои финансы: http://localhost:${PORT}`);
  console.log(`T-Invest: ${process.env.T_INVEST_TOKEN ? 'настроен' : 'требуется T_INVEST_TOKEN'}`);
});
