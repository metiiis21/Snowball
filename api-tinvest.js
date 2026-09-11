export default async function handler(req, res) {
  const token = process.env.T_INVEST_TOKEN;
  if (!token) {
    return res.status(500).json({ error: 'В Vercel не задан T_INVEST_TOKEN' });
  }
  const action = req.query.action;
  try {
    if (action === 'accounts') {
      const data = await tpost('/rest/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts', {}, token);
      return res.status(200).json(data);
    }
    if (action === 'portfolio') {
      const accountId = req.query.accountId;
      if (!accountId) return res.status(400).json({ error: 'accountId обязателен' });
      const data = await tpost('/rest/tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio', { accountId, currency: 'RUB' }, token);
      return res.status(200).json({ portfolio: data });
    }
    return res.status(400).json({ error: 'Неизвестный action' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Ошибка T-Invest API' });
  }
}

async function tpost(path, body, token) {
  const r = await fetch('https://invest-public-api.tinkoff.ru' + path, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!r.ok) {
    const msg = data?.message || data?.error || data?.description || ('T-Invest HTTP ' + r.status);
    throw new Error(msg);
  }
  return data;
}