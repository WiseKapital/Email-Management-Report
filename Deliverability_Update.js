const fs = require('fs');
const path = require('path');
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

let geoip = null;
try { geoip = require('geoip-lite'); } catch { geoip = null; }

const ISPS_MLJ = ['Hotmail', 'Outlook', 'Gmail', 'Yahoo', 'Aol', 'iCloud', 'Other'];
const ISPS_SEG = ['Outlook', 'Hotmail', 'Gmail', 'Yahoo', 'iCloud', 'Aol', 'Other'];
const MESES_CARPETA = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'
];
const MESES_CORTOS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function obtenerAyerColombia() {
    const ahoraCol = new Date(Date.now() - 5 * 60 * 60 * 1000);
    const hoyCol = ahoraCol.toISOString().slice(0, 10);
    const ayerCol = new Date(ahoraCol.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    return { hoyCol, ayerCol };
}

const ISP_EXACT = {
    'gmail.com': 'Gmail', 'googlemail.com': 'Gmail',
    'hotmail.com': 'Hotmail', 'hotmail.ca': 'Hotmail', 'hotmail.fr': 'Hotmail',
    'hotmail.es': 'Hotmail', 'hotmail.de': 'Hotmail', 'hotmail.co.uk': 'Hotmail',
    'hotmail.co.nz': 'Hotmail', 'hotmail.com.ar': 'Hotmail', 'hotmail.com.mx': 'Hotmail',
    'outlook.com': 'Outlook', 'outlook.es': 'Outlook', 'outlook.com.ar': 'Outlook',
    'outlook.co.nz': 'Outlook', 'live.com': 'Outlook', 'live.ca': 'Outlook',
    'live.fr': 'Outlook', 'live.com.ar': 'Outlook', 'msn.com': 'Outlook',
    'yahoo.com': 'Yahoo', 'yahoo.ca': 'Yahoo', 'yahoo.co.uk': 'Yahoo',
    'yahoo.fr': 'Yahoo', 'yahoo.de': 'Yahoo', 'yahoo.es': 'Yahoo',
    'yahoo.com.ar': 'Yahoo', 'yahoo.com.mx': 'Yahoo', 'ymail.com': 'Yahoo', 'y7mail.com': 'Yahoo',
    'aol.com': 'Aol', 'aol.co.uk': 'Aol', 'aim.com': 'Aol',
    'icloud.com': 'iCloud', 'me.com': 'iCloud', 'mac.com': 'iCloud'
};

const ISP_KEYWORDS = [
    ['gmail', 'Gmail'], ['googlemail', 'Gmail'],
    ['hotmail', 'Hotmail'], ['outlook', 'Outlook'], ['live.', 'Outlook'],
    ['yahoo', 'Yahoo'], ['ymail', 'Yahoo'],
    ['aol.', 'Aol'], ['icloud', 'iCloud']
];

function classifyISP(valor) {
    if (!valor) return 'Other';
    let text = String(valor).toLowerCase().trim();
    if (text.includes('@')) text = text.split('@').pop();
    text = text.replace(/\s+/g, '').replace('apple', 'icloud');
    if (ISP_EXACT[text]) return ISP_EXACT[text];
    for (const [kw, name] of ISP_KEYWORDS) {
        if (text.includes(kw)) return name;
    }
    return 'Other';
}

function nuevoMapaISPs() {
    const mapa = {};
    for (const isp of ISPS_MLJ) {
        mapa[isp] = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0, Complaint: 0, UnsubBlocked: 0 };
    }
    return mapa;
}

const esperar = (ms) => new Promise(r => setTimeout(r, ms));

// =======================================================
// 1. MAILJET (secuencial + reintentos ante 504/429)
// =======================================================
async function fetchMailjetPage(url, headers, intentos = 3) {
    for (let i = 1; i <= intentos; i++) {
        try {
            const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
            if (res.ok) {
                const raw = await res.text();
                return JSON.parse(raw.replace(/:\s*(\d{16,})(?=[,\s}\]])/g, ':"$1"'));
            }
            if ([429, 500, 502, 503, 504].includes(res.status) && i < intentos) {
                await esperar(i * 2000);
                continue;
            }
            throw new Error(`Mailjet HTTP ${res.status} en ${url}`);
        } catch (err) {
            if (i === intentos) throw err;
            await esperar(i * 2000);
        }
    }
}

async function fetchAllMailjet(urlBase, headers) {
    const todos = [];
    let offset = 0;
    const limit = 1000;
    while (true) {
        const sep = urlBase.includes('?') ? '&' : '?';
        const json = await fetchMailjetPage(`${urlBase}${sep}Limit=${limit}&Offset=${offset}`, headers);
        const data = json.Data || [];
        todos.push(...data);
        if (data.length < limit) break;
        offset += limit;
    }
    return todos;
}

async function procesarMailjet(nombreCuenta, apiKey, secretKey, fechaStr) {
    const auth = Buffer.from(`${apiKey}:${secretKey}`).toString('base64');
    const headers = { Authorization: `Basic ${auth}` };
    const [y, m, d] = fechaStr.split('-').map(Number);

    // Ventana exacta de AYER en Colombia (00:00:00.000 a 23:59:59.999 COL)
    const fromMs = Date.UTC(y, m - 1, d, 5, 0, 0, 0);
    const toMs = Date.UTC(y, m - 1, d + 1, 4, 59, 59, 999);
    const fromTS = new Date(fromMs).toISOString().slice(0, 19) + 'Z';
    const toTS = new Date(Date.UTC(y, m - 1, d + 1, 5, 0, 0)).toISOString().slice(0, 19) + 'Z';

    const enAyer = (iso) => {
        if (!iso) return true;
        const t = Date.parse(iso);
        return Number.isNaN(t) || (t >= fromMs && t <= toMs);
    };

    // 1) Mensajes (fuente principal)
    const mensajes = await fetchAllMailjet(
        `https://api.mailjet.com/v3/REST/message?FromTS=${fromTS}&ToTS=${toTS}&ShowContactAlt=true&ShowSubject=true`,
        headers
    );

    // 2) Opens y Clicks secuenciales con respaldo por si openinformation da 504
    let openIds = null;
    try {
        const opens = await fetchAllMailjet(
            `https://api.mailjet.com/v3/REST/openinformation?FromTS=${fromTS}&ToTS=${toTS}`,
            headers
        );
        openIds = new Set(opens.filter(o => enAyer(o.OpenedAt)).map(o => String(o.MessageID)));
    } catch (e) {
        console.warn(`${nombreCuenta} aviso openinformation (${e.message}) -> usando Status del mensaje`);
    }

    let clickIds = null;
    try {
        const clicks = await fetchAllMailjet(
            `https://api.mailjet.com/v3/REST/clickstatistics?FromTS=${fromTS}&ToTS=${toTS}`,
            headers
        );
        clickIds = new Set(clicks.filter(c => enAyer(c.ClickedAt)).map(c => String(c.MessageID)));
    } catch (e) {
        console.warn(`${nombreCuenta} aviso clickstatistics (${e.message}) -> usando Status del mensaje`);
    }

    const porISP = nuevoMapaISPs();

    for (const msg of mensajes) {
        if (msg.ArrivedAt && !enAyer(msg.ArrivedAt)) continue;
        const campId = Number(msg.CampaignID || 0);
        const subj = String(msg.Subject || '');
        if (campId === 0 || /\[test\]|\btest\b/i.test(subj)) continue;

        const idStr = String(msg.ID);
        const st = String(msg.Status || '').toLowerCase();
        const isp = classifyISP(msg.ContactAlt);

        const blocked = st === 'blocked';
        const soft = st.includes('soft') || (st === 'bounce' && !msg.StatePermanent);
        const hard = st.includes('hard') || (st === 'bounce' && Boolean(msg.StatePermanent));
        const unsub = st === 'unsub';
        const spam = st === 'spam';
        const clicked = (clickIds ? clickIds.has(idStr) : false) || st === 'clicked';
        const opened = (openIds ? openIds.has(idStr) : st === 'clicked') || st === 'opened';
        const delivered = !(hard || soft || blocked);

        const r = porISP[isp];
        if (delivered) r.Delivered += 1;
        if (soft) r.SoftBounce += 1;
        if (hard) r.HardBounce += 1;
        if (opened) r.Open += 1;
        if (clicked) r.Click += 1;
        if (spam) r.Complaint += 1;
        if (unsub || blocked) r.UnsubBlocked += 1;
    }

    return porISP;
}

// =======================================================
// 2. SENDGRID (solo AYER)
// =======================================================
async function procesarSendgrid(apiKey, fechaStr) {
    const headers = { Authorization: `Bearer ${apiKey}` };
    const porISP = nuevoMapaISPs();
    const estados = {};

    const resISP = await fetch(
        `https://api.sendgrid.com/v3/mailbox_providers/stats?start_date=${fechaStr}&end_date=${fechaStr}&aggregated_by=day`,
        { headers }
    );
    if (!resISP.ok) throw new Error(`SendGrid ISP HTTP ${resISP.status}`);
    const dataISP = await resISP.json();

    for (const dia of (Array.isArray(dataISP) ? dataISP : [])) {
        for (const s of (dia.stats || [])) {
            const isp = classifyISP(s.name);
            const m = s.metrics || {};
            porISP[isp].Delivered += m.delivered || 0;
            porISP[isp].HardBounce += m.bounces || 0;
            porISP[isp].Open += m.opens || 0;
            porISP[isp].Click += m.clicks || 0;
            porISP[isp].Complaint += m.spam_reports || 0;
            porISP[isp].UnsubBlocked += (m.blocks || 0) + (m.unsubscribes || 0);
        }
    }

    const resGeo = await fetch(
        `https://api.sendgrid.com/v3/geo/stats?start_date=${fechaStr}&end_date=${fechaStr}&aggregated_by=day&country=US`,
        { headers }
    );
    if (resGeo.ok) {
        const dataGeo = await resGeo.json();
        for (const dia of (Array.isArray(dataGeo) ? dataGeo : [])) {
            for (const s of (dia.stats || [])) {
                const st = String(s.name || '').trim().toUpperCase();
                if (!st || st === 'ALL' || st === 'US') continue;
                const c = (s.metrics && s.metrics.clicks) ? s.metrics.clicks : 0;
                if (c > 0) estados[st] = (estados[st] || 0) + c;
            }
        }
    }

    return { porISP, estados };
}

// =======================================================
// 3. CLOUDFLARE D1 (solo clics de AYER -> Estados USA)
// =======================================================
async function obtenerEstadosCloudflare(urlBase, fechaStr) {
    const porCuenta = { MLJ1: {}, MLJ2: {}, MLJ_SH: {} };
    if (!urlBase || !urlBase.startsWith('http') || !geoip) return porCuenta;

    const sep = urlBase.includes('?') ? '&' : '?';
    const res = await fetch(`${urlBase}${sep}fecha=${fechaStr}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const clics = json.clics || [];
    console.log(`Cloudflare D1 clics encontrados para ${fechaStr}: ${clics.length}`);

    for (const c of clics) {
        if (c.fecha !== fechaStr || !c.ip || Number(c.campaign_id || 0) === 0) continue;
        const geo = geoip.lookup(c.ip);
        if (geo && geo.country === 'US' && geo.region) {
            const cta = c.cuenta || 'MLJ1';
            if (!porCuenta[cta]) porCuenta[cta] = {};
            const st = String(geo.region).toUpperCase();
            porCuenta[cta][st] = (porCuenta[cta][st] || 0) + 1;
        }
    }
    return porCuenta;
}

// =======================================================
// 4. GUARDAR EN {año}/maildata/maildata_{mes}/{dia}.csv
// =======================================================
const pct = (n, d) => (d > 0 ? ((n / d) * 100).toFixed(2) + '%' : '0.00%');

function formatEstados(mapa) {
    const items = Object.entries(mapa || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    return items.length ? items.map(([k, v]) => `${k}: ${v}`).join(' | ') : '';
}

function csvCell(v) {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function filaCSV(esp, domain, m, usStates = '') {
    return [
        esp, domain,
        m.Delivered, m.SoftBounce, m.HardBounce,
        m.Open, pct(m.Open, m.Delivered),
        m.Click, pct(m.Click, m.Open), pct(m.Click, m.Delivered),
        m.Complaint, m.UnsubBlocked,
        '', '', '', usStates, ''
    ].map(csvCell).join(',');
}

function sumarBloque(porISP) {
    const tot = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0, Complaint: 0, UnsubBlocked: 0 };
    for (const m of Object.values(porISP)) {
        for (const k of Object.keys(tot)) tot[k] += m[k];
    }
    return tot;
}

async function main() {
    const { hoyCol, ayerCol } = obtenerAyerColombia();
    const fechaStr = (process.env.FECHA_MANUAL || '').trim() || ayerCol;
    console.log(`Hoy Colombia: ${hoyCol} | Extrayendo unicamente fecha: ${fechaStr}`);

    const [anioNum, mesNum, diaNum] = fechaStr.split('-').map(Number);
    const fechaCorta = `${MESES_CORTOS[mesNum - 1]}-${diaNum}`;

    const webhookUrl = process.env.CLOUDFLARE_WEBHOOK_URL || process.env.GODADDY_WEBHOOK_URL;
    const gd = await obtenerEstadosCloudflare(webhookUrl, fechaStr)
        .catch(e => { console.error('Cloudflare D1:', e.message); return {}; });

    const mlj1 = (process.env.MJ_KEY_1 && process.env.MJ_SECRET_1)
        ? await procesarMailjet('MLJ1', process.env.MJ_KEY_1, process.env.MJ_SECRET_1, fechaStr).catch(e => { console.error('MLJ1:', e.message); return nuevoMapaISPs(); })
        : nuevoMapaISPs();
    const mlj2 = (process.env.MJ_KEY_2 && process.env.MJ_SECRET_2)
        ? await procesarMailjet('MLJ2', process.env.MJ_KEY_2, process.env.MJ_SECRET_2, fechaStr).catch(e => { console.error('MLJ2:', e.message); return nuevoMapaISPs(); })
        : nuevoMapaISPs();
    const mlj3 = (process.env.MJ_KEY_3 && process.env.MJ_SECRET_3)
        ? await procesarMailjet('MLJ_SH', process.env.MJ_KEY_3, process.env.MJ_SECRET_3, fechaStr).catch(e => { console.error('MLJ_SH:', e.message); return nuevoMapaISPs(); })
        : nuevoMapaISPs();

    const seg1 = process.env.SG_KEY_1
        ? await procesarSendgrid(process.env.SG_KEY_1, fechaStr).catch(e => { console.error('SEG1:', e.message); return { porISP: nuevoMapaISPs(), estados: {} }; })
        : { porISP: nuevoMapaISPs(), estados: {} };
    const seg2 = process.env.SG_KEY_2
        ? await procesarSendgrid(process.env.SG_KEY_2, fechaStr).catch(e => { console.error('SEG2:', e.message); return { porISP: nuevoMapaISPs(), estados: {} }; })
        : { porISP: nuevoMapaISPs(), estados: {} };

    const lineas = [];
    lineas.push(',,,,,,,,,,,,,,,,');
    lineas.push(`,,,,,,,,,,,,,,,Date From:,${fechaCorta}`);
    lineas.push(`,,,,,,,,,,,,,,,Date To:,${fechaCorta}`);
    lineas.push(',,,,,,,,,,,,,,,← Change dates to refresh the report,');
    lineas.push('ESP,Domain,Delivered,Soft Bounce,Hard Bounce,Open,Open Rate,Click,Click-to-open Rate,Click Rate,Complaint,Unsubscribe/Blocked,Registration,Players,Throttling (emails per domain per hour),US States,');

    const grandTotal = { Delivered: 0, SoftBounce: 0, HardBounce: 0, Open: 0, Click: 0, Complaint: 0, UnsubBlocked: 0 };
    const grandStates = {};

    function agregarBloque(tituloESP, subBloques, ordenISPs) {
        lineas.push(`${tituloESP},,,,,,,,,,,,,,,,`);
        for (const b of subBloques) {
            lineas.push(`${b.label},,,,,,,,,,,,,,,,`);
            for (const isp of ordenISPs) {
                lineas.push(filaCSV('', isp, b.porISP[isp]));
            }
            const tot = sumarBloque(b.porISP);
            for (const k of Object.keys(grandTotal)) grandTotal[k] += tot[k];
            for (const [st, cnt] of Object.entries(b.estados || {})) grandStates[st] = (grandStates[st] || 0) + cnt;
            lineas.push(filaCSV('', 'TOTAL', tot, formatEstados(b.estados)));
        }
        lineas.push(',,,,,,,,,,,,,,,,');
    }

    agregarBloque('MLJ (Mailjet)', [
        { label: 'IP 1', porISP: mlj1, estados: gd.MLJ1 || {} },
        { label: 'IP 2', porISP: mlj2, estados: gd.MLJ2 || {} },
        { label: 'IP 3 / SH', porISP: mlj3, estados: gd.MLJ_SH || {} },
    ], ISPS_MLJ);

    agregarBloque('SEG (Sendgrid)', [
        { label: 'IP 1', porISP: seg1.porISP, estados: seg1.estados },
        { label: 'IP 2 / SH', porISP: seg2.porISP, estados: seg2.estados },
    ], ISPS_SEG);

    lineas.push(filaCSV('GRAND TOTAL', '', grandTotal, formatEstados(grandStates)));

    const carpetaDestino = path.join(String(anioNum), 'maildata', `maildata_${MESES_CARPETA[mesNum - 1]}`);
    fs.mkdirSync(carpetaDestino, { recursive: true });
    const rutaArchivo = path.join(carpetaDestino, `${diaNum}.csv`);

    fs.writeFileSync(rutaArchivo, '\uFEFF' + lineas.join('\r\n'), 'utf8');
    console.log(`CSV de AYER guardado en: ${rutaArchivo}`);
}

main();
