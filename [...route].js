const T_BASE = 'https://invest-public-api.tbank.ru/rest/tinkoff.public.invest.api.contract.v1';

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

const decimal = (v) => v ? Number(v.units || 0) + Number(v.nano || 0) / 1e9 : 0;
const money = decimal;
const quote = decimal;

async function enrichPortfolio(accountId) {
  const p = await tCall('OperationsService', 'GetPortfolio', { accountId, currency: 'RUB' });
  const rawPositions = p.positions || [];
  const enriched = await Promise.all(rawPositions.map(async (x) => {
    const uid = x.instrumentUid || x.positionUid || x.figi;
    let instrument = null;
    if (uid) {
      try {
        const info = await tCall('InstrumentsService', 'GetInstrumentBy', {
          idType: x.instrumentUid
            ? 'INSTRUMENT_ID_TYPE_UID'
            : (x.positionUid ? 'INSTRUMENT_ID_TYPE_POSITION_UID' : 'INSTRUMENT_ID_TYPE_FIGI'),
          id: uid
        });
        instrument = info.instrument || null;
      } catch {
        // Не блокируем весь портфель, если метаданные одной бумаги недоступны.
      }
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

  return {
    accountId: p.accountId || accountId,
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
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const raw = req.query?.route;
    const parts = Array.isArray(raw)
      ? raw
      : String(raw || '').split('/').filter(Boolean);

    const action = parts[0] || '';

    if (action === 'status') {
      return res.status(200).json({ configured: Boolean(process.env.T_INVEST_TOKEN) });
    }

    if (action === 'accounts') {
      const data = await tCall('UsersService', 'GetAccounts', { status: 'ACCOUNT_STATUS_OPEN' });
      return res.status(200).json({ accounts: data.accounts || [] });
    }

    if (action === 'portfolio' && parts[1]) {
      const result = await enrichPortfolio(parts[1]);
      return res.status(200).json(result);
    }

    if (action === 'sync') {
      const a = await tCall('UsersService', 'GetAccounts', { status: 'ACCOUNT_STATUS_OPEN' });
      const accounts = a.accounts || [];
      const portfolios = await Promise.all(accounts.map(async (account) => {
        try {
          return await enrichPortfolio(account.id);
        } catch (e) {
          return { accountId: account.id, error: true, message: e?.message || 'Ошибка загрузки счёта' };
        }
      }));
      return res.status(200).json({ accounts, portfolios, syncedAt: new Date().toISOString() });
    }

    return res.status(404).json({ error: 'Маршрут T‑Invest не найден' });
  } catch (err) {
    const status = Number(err?.status) || 500;
    return res.status(status).json({
      error: err?.message || 'Ошибка сервера',
      trackingId: err?.trackingId || undefined
    });
  }
}
