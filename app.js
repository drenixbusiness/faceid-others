require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const axios = require('axios');
const Database = require('better-sqlite3');
const multer = require('multer');
const { google } = require('googleapis');

// ====== CONFIG ======
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const PORT = Number(process.env.PORT || 8090);
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '';
const GOOGLE_SHEET_NAME = process.env.GOOGLE_SHEET_NAME || 'Events';
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || '';
const GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const DB_PATH = process.env.DB_PATH || './attendance.db';
const KAISEN_BOT_URL = process.env.KAISEN_BOT_URL || '';
const DEBUG_WEBHOOKS = false;
const DIAG_EVENT_LINE = true;
const BUSINESS_TIMEZONE = 'Asia/Tashkent';
const BUSINESS_OFFSET = '+05:00';
const NO_SHOW_CHECK_INTERVAL_MS = 60000;
const BREAK_LIMIT_MIN = 30;
const ON_TIME_GRACE_MIN = 10;
const DIDNT_COME_AFTER_MIN = 120;
const VERY_LATE_AFTER_MIN = DIDNT_COME_AFTER_MIN + ON_TIME_GRACE_MIN;
const BOT_CHECKIN_NOTIFICATIONS_FROM_HHMM = '14:00';
// ====================

const SHIFT_RULES = {
    '5-2': {
        label: 'Shift 5-2',
        workStart: '17:00',
        workEnd: '02:00',
        validCheckInFrom: '13:00',
        validCheckInTo: '19:00',
        validCheckOutFrom: '01:50',
        validCheckOutTo: '10:00',
        checkOutDayOffset: 1,
        lateAllowableMin: 10
    },
    '6-3': {
        label: 'Shift 6-3',
        workStart: '18:00',
        workEnd: '03:00',
        validCheckInFrom: '14:00',
        validCheckInTo: '19:00',
        validCheckOutFrom: '02:50',
        validCheckOutTo: '11:00',
        checkOutDayOffset: 1,
        lateAllowableMin: 10
    },
    '7-4': {
        label: 'Shift 7-4',
        workStart: '19:00',
        workEnd: '04:00',
        validCheckInFrom: '15:00',
        validCheckInTo: '20:00',
        validCheckOutFrom: '03:50',
        validCheckOutTo: '12:00',
        checkOutDayOffset: 1,
        lateAllowableMin: 10
    }
};

// ====== OTHER TEAM EMPLOYEES ======
const EMPLOYEE_SHIFT_MAP = {
    '001': { name: 'Suxrob', shiftKey: '6-3' },
    '18': { name: 'Abdulaziz', shiftKey: '6-3' },
    '002': { name: 'Asadbek Odilov', shiftKey: '7-4' },
    '7': { name: 'Fayzulloh Winston', shiftKey: '6-3' },
    '8': { name: 'Diyor Ethan', shiftKey: '6-3' },
    '9': { name: 'Fazliddin Fred', shiftKey: '6-3' },
    '10': { name: 'Asadbek Henry', shiftKey: '5-2' },
    '11': { name: 'Amirshoh Alex', shiftKey: '6-3' },
    '14': { name: 'Azizbek Tony', shiftKey: '5-2' },
    '19': { name: 'Jessica', shiftKey: '6-3' },
    '27': { name: 'Nigora', shiftKey: '7-4' },
    '20': { name: 'Hamidullo', shiftKey: '6-3' },
    '036': { name: 'Odina', shiftKey: '6-3' },
    '35': { name: 'Shaxzoda', shiftKey: '6-3' },
    '38': { name: 'Otabek', shiftKey: '6-3' },
    '44': { name: 'Mexriddin', shiftKey: '6-3' },
    '45': { name: 'Ahmad', shiftKey: '6-3' },
};

const EMPLOYEE_SECRET_KEYS = {
    '001': '4yB!isuxrs',
    '18': 'byyDd5g@aa',
    '002': '#sFtgaays3',
    '7': 'Wy!ahyf8nr',
    '8': 'k!wir2Ydwy',
    '9': '2habzgfUc#',
    '10': '&y9Maefska',
    '11': 'nq@ia4mMjr',
    '14': 'v4wbRi!raz',
    '19': 'Fp@sjeh8cu',
    '27': 'g9n&rwiMyh',
    '20': 'Cuywh5he@m',
    '036': 'miadqo#D4a',
    '35': 'p!weazbHc4',
    '38': '2nq@t#iawr',
    '44': 'h2#p9ixo8g',
    '45': 'g#e@wmxn8r'
};
// ==================================

const app = express();
const upload = multer();
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id TEXT,
    employee_name TEXT,
    employee_gender TEXT,
    status TEXT,
    timestamp TEXT
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS daily_attendance (
    employee_id TEXT NOT NULL,
    shift_date TEXT NOT NULL,
    shift_key TEXT NOT NULL,
    first_check_in_at TEXT,
    first_check_in_name TEXT,
    first_check_in_gender TEXT,
    first_check_in_late_min INTEGER,
    check_out_at TEXT,
    absent_notified INTEGER DEFAULT 0,
    PRIMARY KEY(employee_id, shift_date)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS break_overtime_alerts (
    employee_id TEXT NOT NULL,
    break_out_at TEXT NOT NULL,
    alerted_at TEXT NOT NULL,
    PRIMARY KEY(employee_id, break_out_at)
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS registered_users (
    telegram_chat_id TEXT NOT NULL,
    employee_id TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    PRIMARY KEY(telegram_chat_id)
  )
`);
try {
    db.exec(`ALTER TABLE attendance ADD COLUMN employee_gender TEXT`);
} catch (err) {
    if (!String(err.message).toLowerCase().includes('duplicate column')) throw err;
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

async function sendTelegram(message) {
    if (!TELEGRAM_CHAT_ID) {
        console.warn('Telegram warning: TELEGRAM_CHAT_ID is empty, message skipped.');
        return;
    }
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' }
        );
    } catch (err) {
        console.error('Telegram error:', err.message);
    }
}

async function sendTelegramToChat(chatId, message) {
    if (!chatId) return;
    try {
        await axios.post(
            `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
            { chat_id: chatId, text: message, parse_mode: 'HTML' }
        );
    } catch (err) {
        console.error(`Telegram error (chat ${chatId}):`, err.message);
    }
}

async function sendPersonalDm(employeeId, message) {
    if (!employeeId) return;
    const personalBotUrl = process.env.PERSONAL_BOT_URL || 'http://localhost:8092';
    try {
        await axios.post(`${personalBotUrl}/notify`, { employeeId, message });
    } catch (err) {
        console.error('Personal DM error:', err.message);
    }
}

function normalizeGender(rawGender) {
    if (!rawGender) return 'Unknown';
    const value = String(rawGender).trim().toLowerCase();
    if (['male', 'm', 'man', '1'].includes(value)) return 'Male';
    if (['female', 'f', 'woman', '2', '0'].includes(value)) return 'Female';
    return 'Unknown';
}

function parseEventTime(evt) {
    const raw = evt.dateTime || evt.localTime || evt.sendTime || evt.time || evt.timestamp;
    if (!raw) return new Date();
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

function formatDateInZone(date) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: BUSINESS_TIMEZONE,
        year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(date);
}

function formatDateTimeInZone(date) {
    return date.toLocaleString('en-GB', { timeZone: BUSINESS_TIMEZONE });
}

function addDaysToDateString(dateStr, days) {
    const [year, month, day] = dateStr.split('-').map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    utcDate.setUTCDate(utcDate.getUTCDate() + days);
    const yyyy = utcDate.getUTCFullYear();
    const mm = String(utcDate.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(utcDate.getUTCDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function isSundayDateString(dateStr) {
    const [year, month, day] = String(dateStr).split('-').map(Number);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0;
}

function hhmmToMinutes(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return (h * 60) + m;
}

function getMinutesInZone(date) {
    const hhmm = new Intl.DateTimeFormat('en-GB', {
        timeZone: BUSINESS_TIMEZONE,
        hour12: false, hour: '2-digit', minute: '2-digit'
    }).format(date);
    return hhmmToMinutes(hhmm);
}

function makeShiftDateTime(shiftDate, hhmm, dayOffset = 0) {
    const datePart = addDaysToDateString(shiftDate, dayOffset);
    return new Date(`${datePart}T${hhmm}:00${BUSINESS_OFFSET}`);
}

function minutesBetween(later, earlier) {
    return Math.max(0, Math.round((later.getTime() - earlier.getTime()) / 60000));
}

function formatDuration(from, to) {
    const mins = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60000));
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}h ${m}m`;
}

function formatWorkedDuration(firstCheckInAtIso, checkOutAt, shiftDate, shift) {
    const shiftStart = makeShiftDateTime(shiftDate, shift.workStart, 0);
    let effectiveStart = shiftStart;
    if (firstCheckInAtIso) {
        const firstCheckInAt = new Date(firstCheckInAtIso);
        if (!Number.isNaN(firstCheckInAt.getTime()) && firstCheckInAt > shiftStart) {
            effectiveStart = firstCheckInAt;
        }
    }
    return formatDuration(effectiveStart, checkOutAt);
}

function getEmployeeShift(employeeId) {
    if (!employeeId) return null;
    return EMPLOYEE_SHIFT_MAP[String(employeeId)] || null;
}

function resolveShiftDateForEvent(eventTime, shift) {
    const today = formatDateInZone(eventTime);
    const yesterday = addDaysToDateString(today, -1);
    if (shift.checkOutDayOffset > 0) {
        const nowMin = getMinutesInZone(eventTime);
        const checkInFromMin = hhmmToMinutes(shift.validCheckInFrom);
        if (nowMin < checkInFromMin) {
            const yesterdaySpanTo = makeShiftDateTime(yesterday, shift.validCheckOutTo, shift.checkOutDayOffset);
            if (eventTime <= yesterdaySpanTo) return yesterday;
        }
    }
    const candidates = [today, yesterday];
    for (const shiftDate of candidates) {
        const spanFrom = makeShiftDateTime(shiftDate, shift.validCheckInFrom, 0);
        const spanTo = makeShiftDateTime(shiftDate, shift.validCheckOutTo, shift.checkOutDayOffset);
        if (eventTime >= spanFrom && eventTime <= spanTo) return shiftDate;
    }
    return today;
}

function classifyPunch(eventTime, statusRaw, shift, shiftDate) {
    if (statusRaw === 'insideExit') {
        const checkOutFrom = makeShiftDateTime(shiftDate, shift.validCheckOutFrom, shift.checkOutDayOffset);
        const checkOutTo = makeShiftDateTime(shiftDate, shift.validCheckOutTo, shift.checkOutDayOffset);

        if (eventTime >= checkOutFrom && eventTime <= checkOutTo) {
            return 'checkOut';
        }

        return 'breakOut';
    }
    if (statusRaw === 'checkIn') return 'checkIn';
    if (statusRaw === 'checkOut') return 'checkOut';
    if (statusRaw === 'breakIn') return 'breakIn';
    if (statusRaw === 'breakOut') return 'breakOut';
    const checkInFrom = makeShiftDateTime(shiftDate, shift.validCheckInFrom, 0);
    const checkInTo = makeShiftDateTime(shiftDate, shift.validCheckInTo, 0);
    const checkOutFrom = makeShiftDateTime(shiftDate, shift.validCheckOutFrom, shift.checkOutDayOffset);
    const checkOutTo = makeShiftDateTime(shiftDate, shift.validCheckOutTo, shift.checkOutDayOffset);
    if (eventTime >= checkInFrom && eventTime <= checkInTo) return 'checkIn';
    if (eventTime >= checkOutFrom && eventTime <= checkOutTo) return 'checkOut';
    return 'access';
}

const statusMap = {
    checkIn: { label: 'Check In', emoji: '✅' },
    checkOut: { label: 'Check Out', emoji: '🏁' },
    breakOut: { label: 'Break Out', emoji: '☕' },
    breakIn: { label: 'Break In', emoji: '🔙' }
};

const statusAliases = {
    checkin: 'checkIn',
    checkout: 'checkOut',
    breakin: 'breakIn',
    breakout: 'breakOut'
};

// ===== DEVICE STATUS REMAPPING =====
const OUTSIDE_DEVICE_IPS = (process.env.OUTSIDE_DEVICE_IPS || '')
    .split(',')
    .map(ip => ip.trim())
    .filter(Boolean);

const INSIDE_DEVICE_IPS = (process.env.INSIDE_DEVICE_IPS || '')
    .split(',')
    .map(ip => ip.trim())
    .filter(Boolean);

function normalizeVerifyMode(evt) {
    const raw =
        evt.currentVerifyMode ||
        evt.verifyMode ||
        evt.verificationMode ||
        evt.authMode ||
        evt.readerVerifyMode ||
        evt.AccessControllerEvent?.currentVerifyMode ||
        evt.AccessControllerEvent?.verifyMode ||
        evt.AccessControllerEvent?.verificationMode ||
        evt.AccessControllerEvent?.authMode ||
        evt.AccessControllerEvent?.readerVerifyMode ||
        '';

    const value = String(raw).toLowerCase();

    if (value.includes('finger')) return 'fingerprint';
    if (value.includes('fp')) return 'fingerprint';
    if (value.includes('face')) return 'face';

    return 'unknown';
}

function remapStatusByDeviceAndVerifyMode(deviceIp, evt, statusRaw) {
    const verifyMode = normalizeVerifyMode(evt);

    const isOutside = OUTSIDE_DEVICE_IPS.includes(deviceIp);
    const isInside = INSIDE_DEVICE_IPS.includes(deviceIp);

    if (isOutside && verifyMode === 'fingerprint') return 'checkIn';
    if (isInside && verifyMode === 'fingerprint') return 'checkOut';

    if (isInside && verifyMode === 'face') return 'breakOut';
    if (isOutside && verifyMode === 'face') return 'breakIn';

    return statusRaw;
}

const recentEventCache = new Map();
let lastWebhookSnapshot = null;
let sheetsClientPromise = null;
const googleSheetHeaderEnsuredKeys = new Set();
const googleSheetTabEnsuredKeys = new Set();
const GOOGLE_SHEET_HEADER = [
    'Time Local', 'Employee id', 'Employee Name', 'Action',
    'Shift Time', 'Shift Date', 'Late Minutes', "Didn't Come"
];

function quoteSheetNameForRange(sheetName) {
    const safe = String(sheetName || 'Sheet1').replace(/'/g, "''");
    return `'${safe}'`;
}

function getHeaderRange(sheetName) {
    const endCol = String.fromCharCode('A'.charCodeAt(0) + GOOGLE_SHEET_HEADER.length - 1);
    return `${quoteSheetNameForRange(sheetName)}!A1:${endCol}1`;
}

function buildSheetRow({ timeLocal, employeeId, employeeName, action, shiftTime, shiftDate, lateMinutes, didntCome }) {
    return [
        timeLocal || '',
        employeeId || 'unknown',
        employeeName || 'Unknown',
        action || '',
        shiftTime || '',
        shiftDate || '',
        Number.isFinite(lateMinutes) ? String(lateMinutes) : '',
        didntCome ? 'YES' : ''
    ];
}

function formatShiftTime(shift) {
    if (!shift) return '';
    return `${shift.workStart}-${shift.workEnd}`;
}

function isGoogleSheetsEnabled() {
    return Boolean(GOOGLE_SHEET_ID && GOOGLE_SERVICE_ACCOUNT_EMAIL && GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
}

function buildSheetEnsureKey(spreadsheetId, sheetName) {
    return `${spreadsheetId}::${sheetName}`;
}

async function getGoogleSheetsClient() {
    if (!isGoogleSheetsEnabled()) return null;
    if (!sheetsClientPromise) {
        sheetsClientPromise = (async () => {
            const auth = new google.auth.JWT({
                email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
                key: GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
                scopes: ['https://www.googleapis.com/auth/spreadsheets']
            });
            await auth.authorize();
            return google.sheets({ version: 'v4', auth });
        })().catch((err) => {
            sheetsClientPromise = null;
            throw err;
        });
    }
    return sheetsClientPromise;
}

async function ensureGoogleSheetTab(spreadsheetId, sheetName) {
    if (!isGoogleSheetsEnabled() || !spreadsheetId || !sheetName) return;
    const key = buildSheetEnsureKey(spreadsheetId, sheetName);
    if (googleSheetTabEnsuredKeys.has(key)) return;
    try {
        const sheets = await getGoogleSheetsClient();
        if (!sheets) return;
        const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets.properties.title' });
        const titles = (meta.data.sheets || []).map((s) => s.properties?.title).filter(Boolean);
        if (!titles.includes(sheetName)) {
            await sheets.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests: [{ addSheet: { properties: { title: sheetName } } }] }
            });
            console.log(`📄 Created Google Sheet tab: ${sheetName}`);
        }
        googleSheetTabEnsuredKeys.add(key);
    } catch (err) {
        console.error('Google Sheets tab setup error:', err.message);
    }
}

async function ensureGoogleSheetHeader(spreadsheetId, sheetName) {
    if (!isGoogleSheetsEnabled() || !spreadsheetId || !sheetName) return;
    const key = buildSheetEnsureKey(spreadsheetId, sheetName);
    if (googleSheetHeaderEnsuredKeys.has(key)) return;
    try {
        await ensureGoogleSheetTab(spreadsheetId, sheetName);
        const sheets = await getGoogleSheetsClient();
        if (!sheets) return;
        const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: getHeaderRange(sheetName) });
        const firstRow = headerRes.data.values && headerRes.data.values[0] ? headerRes.data.values[0] : [];
        if (firstRow.join('|') !== GOOGLE_SHEET_HEADER.join('|')) {
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: getHeaderRange(sheetName),
                valueInputOption: 'RAW',
                requestBody: { values: [GOOGLE_SHEET_HEADER] }
            });
        }
        googleSheetHeaderEnsuredKeys.add(key);
    } catch (err) {
        console.error('Google Sheets header setup error:', err.message);
    }
}

async function appendEventToGoogleSheet(rowValues) {
    if (!isGoogleSheetsEnabled()) return;
    try {
        await ensureGoogleSheetHeader(GOOGLE_SHEET_ID, GOOGLE_SHEET_NAME);
        const sheets = await getGoogleSheetsClient();
        if (!sheets) return;
        await sheets.spreadsheets.values.append({
            spreadsheetId: GOOGLE_SHEET_ID,
            range: `${quoteSheetNameForRange(GOOGLE_SHEET_NAME)}!A2`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [rowValues] }
        });
    } catch (err) {
        console.error('Google Sheets append error:', err.message);
    }
}

function tryParseJson(raw) {
    if (typeof raw !== 'string') return raw;
    try { return JSON.parse(raw); } catch (err) { return raw; }
}

function extractXmlTag(xmlText, tagName) {
    if (typeof xmlText !== 'string') return null;
    const match = xmlText.match(new RegExp(`<${tagName}>([^<]*)</${tagName}>`, 'i'));
    return match ? match[1] : null;
}

function eventFromXml(xmlText) {
    if (typeof xmlText !== 'string' || !xmlText.includes('<')) return null;
    const employeeId =
        extractXmlTag(xmlText, 'employeeNoString') ||
        extractXmlTag(xmlText, 'employeeNo') ||
        extractXmlTag(xmlText, 'cardNo');
    const employeeName = extractXmlTag(xmlText, 'name') || extractXmlTag(xmlText, 'personName');
    const attendanceStatus =
        extractXmlTag(xmlText, 'attendanceStatus') ||
        extractXmlTag(xmlText, 'checkType') ||
        extractXmlTag(xmlText, 'status');
    const dateTime = extractXmlTag(xmlText, 'dateTime') || extractXmlTag(xmlText, 'localTime') || extractXmlTag(xmlText, 'sendTime');
    const majorEventType = extractXmlTag(xmlText, 'majorEventType');
    const minorEventType = extractXmlTag(xmlText, 'minorEventType');
    if (!employeeId && !employeeName && !attendanceStatus && !majorEventType && !minorEventType) return null;
    return { employeeNoString: employeeId, name: employeeName, attendanceStatus, dateTime, majorEventType, minorEventType };
}

function extractAccessEvent(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.AccessControllerEvent) return tryParseJson(data.AccessControllerEvent);
    if (data.EventNotificationAlert && data.EventNotificationAlert.AccessControllerEvent) {
        return tryParseJson(data.EventNotificationAlert.AccessControllerEvent);
    }
    if (data.AcsEventInfo) return tryParseJson(data.AcsEventInfo);
    if (data.AcsEvent && data.AcsEvent.Info) return tryParseJson(data.AcsEvent.Info);
    if (data.event_log) {
        const parsed = tryParseJson(data.event_log);
        if (parsed && typeof parsed === 'object') return extractAccessEvent(parsed) || parsed.AccessControllerEvent || null;
    }
    if (typeof data.EventNotificationAlert === 'string') {
        const parsedAlert = tryParseJson(data.EventNotificationAlert);
        if (parsedAlert && typeof parsedAlert === 'object') return extractAccessEvent({ EventNotificationAlert: parsedAlert });
        return eventFromXml(data.EventNotificationAlert);
    }
    if (typeof data.AccessControllerEvent === 'string' && data.AccessControllerEvent.includes('<')) {
        return eventFromXml(data.AccessControllerEvent);
    }
    for (const [key, value] of Object.entries(data)) {
        if (typeof value === 'string' && (key.toLowerCase().includes('event') || key.toLowerCase().includes('alert'))) {
            const xmlEvent = eventFromXml(value);
            if (xmlEvent) return xmlEvent;
            const parsed = tryParseJson(value);
            if (parsed && typeof parsed === 'object') {
                const nested = extractAccessEvent(parsed);
                if (nested) return nested;
            }
        }
    }
    return null;
}

function normalizeAccessEventShape(evt) {
    if (!evt || typeof evt !== 'object') return evt;
    const nested = evt.AccessControllerEvent && typeof evt.AccessControllerEvent === 'object'
        ? evt.AccessControllerEvent : null;
    if (!nested) return evt;
    return {
        ...evt, ...nested,
        dateTime: nested.dateTime || evt.dateTime,
        localTime: nested.localTime || evt.localTime,
        sendTime: nested.sendTime || evt.sendTime
    };
}

function isDuplicateEvent(evt, employeeId, normalizedStatus) {
    const eventKey = [
        employeeId || 'unknown',
        normalizedStatus || 'unknown',
        evt.dateTime || evt.localTime || evt.sendTime || evt.timestamp || ''
    ].join('|');
    const now = Date.now();
    const lastSeen = recentEventCache.get(eventKey);
    recentEventCache.set(eventKey, now);
    for (const [key, ts] of recentEventCache) {
        if (now - ts > 120000) recentEventCache.delete(key);
    }
    return lastSeen && now - lastSeen < 15000;
}

async function handleEvent(data, sourceIp) {
    let evt = extractAccessEvent(data);
    console.log('RAW HIKVISION EVENT:', JSON.stringify(evt, null, 2));
    if (!evt) return;
    if (typeof evt === 'string') {
        try { evt = JSON.parse(evt); } catch (e) { return; }
    }
    evt = normalizeAccessEventShape(evt);

    const employeeId =
        evt.employeeNoString || evt.employeeNo || evt.employeeID || evt.cardNo || evt.cardReaderNo ||
        evt.EmployeeInfo?.employeeNoString || evt.EmployeeInfo?.employeeNo ||
        evt.UserInfo?.employeeNoString || evt.UserInfo?.employeeNo ||
        evt.AccessControllerEvent?.employeeNoString || evt.AccessControllerEvent?.employeeNo;
    const employeeName =
        evt.name || evt.EmployeeInfo?.name || evt.UserInfo?.name ||
        evt.personName || evt.AccessControllerEvent?.name;
    const gender = normalizeGender(
        evt.gender || evt.sex || evt.personGender || evt.employeeGender ||
        evt.EmployeeInfo?.gender || evt.UserInfo?.gender
    );

    if (!employeeId && !employeeName) return;

    // Ignore employees not in this team's roster
    if (employeeId && !EMPLOYEE_SHIFT_MAP[String(employeeId)]) return;

    const statusRawOriginal =
        evt.attendanceStatus || evt.status || evt.checkType ||
        evt.AccessControllerEvent?.attendanceStatus || evt.AccessControllerEvent?.status || evt.AccessControllerEvent?.checkType;
    let statusRaw = statusAliases[String(statusRawOriginal || '').trim().toLowerCase()] || statusRawOriginal;

    // remap status based on device IP
    statusRaw = remapStatusByDeviceAndVerifyMode(sourceIp, evt, statusRaw);
    console.log(
        'DEVICE MAP DEBUG:',
        'sourceIp=', sourceIp,
        'verifyMode=', normalizeVerifyMode(evt),
        'raw=', statusRawOriginal,
        'mapped=', statusRaw
    );
    const status = statusMap[statusRaw] || {
        label: statusRawOriginal || evt.minorEventType || evt.subEventType || evt.eventType || evt.label || 'Access Event',
        emoji: '📌'
    };
    const duplicateKeyStatus = statusRaw || status.label;

    if (DIAG_EVENT_LINE) {
        console.log(`📨 access-event | id=${employeeId || '-'} | name=${employeeName || '-'} | status=${statusRawOriginal || '-'}`);
    }

    if (isDuplicateEvent(evt, employeeId, duplicateKeyStatus)) return;

    const eventTime = parseEventTime(evt);
    const timeStr = formatDateTimeInZone(eventTime);
    const shiftInfo = getEmployeeShift(employeeId);
    const configuredShift = shiftInfo && SHIFT_RULES[shiftInfo.shiftKey] ? SHIFT_RULES[shiftInfo.shiftKey] : null;
    const shiftDate = configuredShift ? resolveShiftDateForEvent(eventTime, configuredShift) : formatDateInZone(eventTime);

    if (configuredShift && isSundayDateString(shiftDate)) {
        if (DIAG_EVENT_LINE) console.log(`↳ sunday shift ignored | id=${employeeId || '-'} | shiftDate=${shiftDate}`);
        return;
    }

    const checkType = configuredShift ? classifyPunch(eventTime, statusRaw, configuredShift, shiftDate) : (statusRaw || 'access');

    db.prepare(`
      INSERT INTO attendance (employee_id, employee_name, employee_gender, status, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `).run(employeeId || 'unknown', employeeName || 'unknown', gender, checkType, eventTime.toISOString());

    const baseMessage =
        `👤 Name: ${employeeName || 'Unknown'}\n` +
        `🆔 ID: ${employeeId || 'Unknown'}\n` +
        `🕒 Time: ${timeStr}`;

    if (checkType === 'breakOut') {
        const msg =
            `☕ <b>TEST Break Out</b>\n\n` +
            `👤 Name: ${employeeName || 'Unknown'}\n` +
            `🆔 ID: ${employeeId || 'Unknown'}\n` +
            `🕒 Time: ${timeStr}\n` +
            `📍 Source IP: ${sourceIp}\n` +
            `🧾 Raw status: ${statusRawOriginal || 'empty'}\n` +
            `✅ Mapped status: ${statusRaw}`;

        await sendTelegram(msg);
        return;
    }

    if (checkType === 'breakIn') {
        const msg =
            `🔙 <b>TEST Break In</b>\n\n` +
            `👤 Name: ${employeeName || 'Unknown'}\n` +
            `🆔 ID: ${employeeId || 'Unknown'}\n` +
            `🕒 Time: ${timeStr}\n` +
            `📍 Source IP: ${sourceIp}\n` +
            `🧾 Raw status: ${statusRawOriginal || 'empty'}\n` +
            `✅ Mapped status: ${statusRaw}`;

        await sendTelegram(msg);
        return;
    }
    
    if (!configuredShift) return;

    const existingDay = db.prepare(`
  SELECT * FROM daily_attendance WHERE employee_id = ? AND shift_date = ?
`).get(employeeId, shiftDate);

    if (checkType === 'checkIn') {
        const botCheckInNotificationsFromMin = hhmmToMinutes(BOT_CHECKIN_NOTIFICATIONS_FROM_HHMM);

        if (getMinutesInZone(eventTime) < botCheckInNotificationsFromMin) {
            if (DIAG_EVENT_LINE) console.log(`↳ early check-in ignored | id=${employeeId || '-'} | before=${BOT_CHECKIN_NOTIFICATIONS_FROM_HHMM}`);
            return;
        }

        if (existingDay && existingDay.first_check_in_at) {
            const lastBreakOut = db.prepare(`
      SELECT timestamp FROM attendance
      WHERE employee_id = ? AND status = 'breakOut' AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT 1
    `).get(employeeId, eventTime.toISOString());

            let breakDurationText = '';
            if (lastBreakOut) {
                breakDurationText = `\n⏱ Break duration: <b>${formatDuration(new Date(lastBreakOut.timestamp), eventTime)}</b>`;
            }

            db.prepare(`
      INSERT INTO attendance (
        employee_id,
        employee_name,
        employee_gender,
        status,
        timestamp
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
                employeeId || 'unknown',
                employeeName || 'unknown',
                gender,
                'breakIn',
                eventTime.toISOString()
            );

            return;
        }

        const workStart = makeShiftDateTime(shiftDate, configuredShift.workStart, 0);
        const lateMin = minutesBetween(eventTime, workStart);
        const lateFlag = lateMin > ON_TIME_GRACE_MIN && lateMin <= VERY_LATE_AFTER_MIN;
        const didntComeFlag = lateMin > VERY_LATE_AFTER_MIN;

        db.prepare(`
      INSERT INTO daily_attendance (
        employee_id, shift_date, shift_key,
        first_check_in_at, first_check_in_name, first_check_in_gender, first_check_in_late_min
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(employee_id, shift_date) DO UPDATE SET
        shift_key = excluded.shift_key,
        first_check_in_at = COALESCE(daily_attendance.first_check_in_at, excluded.first_check_in_at),
        first_check_in_name = COALESCE(daily_attendance.first_check_in_name, excluded.first_check_in_name),
        first_check_in_gender = COALESCE(daily_attendance.first_check_in_gender, excluded.first_check_in_gender),
        first_check_in_late_min = COALESCE(daily_attendance.first_check_in_late_min, excluded.first_check_in_late_min)
    `).run(employeeId, shiftDate, shiftInfo.shiftKey, eventTime.toISOString(), employeeName || 'Unknown', gender, lateMin);

        let header = '✅ <b>On-Time Check In</b>';
        if (lateFlag) header = '⏰ <b>Late Check In</b>';
        if (didntComeFlag) header = '🚫 <b>Very Late</b>';

        let msg = `${header}\n\n🏷 Shift: ${configuredShift.label}\n${baseMessage}`;
        if (didntComeFlag) msg += `\n🚫 Marked as: <b>Did Not Come</b>\n⏱ Late by: <b>${lateMin} min</b>`;
        else if (lateFlag) msg += `\n\n🚨 Late by: <b>${lateMin} min</b>`;
        else msg += `\n🟢 On time (within ${ON_TIME_GRACE_MIN} min grace)`;

        await sendTelegram(msg);
        await sendPersonalDm(employeeId, msg);
        return;
    }

    if (checkType === 'checkOut') {
        db.prepare(`
      INSERT INTO daily_attendance (employee_id, shift_date, shift_key, check_out_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(employee_id, shift_date) DO UPDATE SET
        shift_key = excluded.shift_key,
        check_out_at = excluded.check_out_at
    `).run(employeeId, shiftDate, shiftInfo.shiftKey, eventTime.toISOString());

        const dayRow = db.prepare(`
      SELECT first_check_in_at FROM daily_attendance WHERE employee_id = ? AND shift_date = ?
    `).get(employeeId, shiftDate);

        let msg = `🏁 <b>Check Out</b>\n🏷 Shift: ${configuredShift.label}\n${baseMessage}`;

        if (dayRow && dayRow.first_check_in_at) {
            msg += `\n⏱ Worked: <b>${formatWorkedDuration(dayRow.first_check_in_at, eventTime, shiftDate, configuredShift)}</b>`;
        }

        await sendTelegram(msg);
        await sendPersonalDm(employeeId, msg);
        return;
    }
}

async function runBreakOvertimeCheck() {
    const now = new Date();
    const cutoff = new Date(now.getTime() - BREAK_LIMIT_MIN * 60000).toISOString();
    const windowStart = new Date(now.getTime() - 12 * 60 * 60000).toISOString();

    const overdueBreaks = db.prepare(`
      SELECT a.employee_id, a.employee_name, a.timestamp
      FROM attendance a
      WHERE a.status = 'breakOut'
        AND a.timestamp <= ?
        AND a.timestamp >= ?
        AND NOT EXISTS (
          SELECT 1 FROM attendance b
          WHERE b.employee_id = a.employee_id
            AND b.status = 'breakIn'
            AND b.timestamp > a.timestamp
        )
        AND NOT EXISTS (
          SELECT 1 FROM break_overtime_alerts x
          WHERE x.employee_id = a.employee_id
            AND x.break_out_at = a.timestamp
        )
    `).all(cutoff, windowStart);

    for (const row of overdueBreaks) {
        const msg =
            `⚠️ <b>Break Warning</b>\n\n` +
            `👤 Name: ${row.employee_name || 'Unknown'}\n` +
            `🆔 ID: ${row.employee_id}\n` +
            `⏱ Break time: <b>${formatDuration(new Date(row.timestamp), now)}</b>\n` +
            `🚨 Please come back. You have been on break for more than ${BREAK_LIMIT_MIN} minutes.`;

        db.prepare(`
          INSERT OR IGNORE INTO break_overtime_alerts (employee_id, break_out_at, alerted_at)
          VALUES (?, ?, ?)
        `).run(row.employee_id, row.timestamp, now.toISOString());

        await sendPersonalDm(row.employee_id, msg);
    }
}

async function runNoShowCheck() {
    const now = new Date();
    const today = formatDateInZone(now);
    if (isSundayDateString(today)) return;

    for (const [employeeId, info] of Object.entries(EMPLOYEE_SHIFT_MAP)) {
        const shift = SHIFT_RULES[info.shiftKey];
        if (!shift) continue;

        const lateDeadline = makeShiftDateTime(today, shift.workStart, 0);
        lateDeadline.setMinutes(lateDeadline.getMinutes() + VERY_LATE_AFTER_MIN);
        const finalCheckInCutoff = makeShiftDateTime(today, shift.validCheckInTo, 0);
        const noShowAfter = lateDeadline > finalCheckInCutoff ? lateDeadline : finalCheckInCutoff;
        const checkOutCutoff = makeShiftDateTime(today, shift.validCheckOutTo, shift.checkOutDayOffset);
        if (!(now > noShowAfter && now < checkOutCutoff)) continue;

        const row = db.prepare(`
          SELECT first_check_in_at, absent_notified FROM daily_attendance
          WHERE employee_id = ? AND shift_date = ?
        `).get(employeeId, today);
        if (row && row.first_check_in_at) continue;
        if (row && row.absent_notified) continue;

        db.prepare(`
          INSERT INTO daily_attendance (employee_id, shift_date, shift_key, absent_notified)
          VALUES (?, ?, ?, 1)
          ON CONFLICT(employee_id, shift_date) DO UPDATE SET absent_notified = 1
        `).run(employeeId, today, info.shiftKey);

        const name = info.name || 'Unknown';
        const noShowMsg =
            `🚫 <b>No Show Alert</b>\n` +
            `👤 Name: ${name}\n` +
            `🆔 ID: ${employeeId}\n` +
            `🏷 Shift: ${shift.label}\n` +
            `📅 Shift Date: ${today}\n` +
            `⏱ No check-in received within ${VERY_LATE_AFTER_MIN} minutes of shift start`;

        await sendTelegram(noShowMsg);
        await sendPersonalDm(employeeId, noShowMsg);
        await appendEventToGoogleSheet(buildSheetRow({
            timeLocal: formatDateTimeInZone(now), employeeId,
            employeeName: name, action: 'Did Not Come (No Check In)',
            shiftTime: formatShiftTime(shift), shiftDate: today, didntCome: true
        }));
        console.log(`🚫 SENT: no-show alert — ${name} (${employeeId})`);
    }
}

app.post('/hikvision/event', upload.any(), async (req, res) => {
    console.log('Incoming webhook request received at /hikvision/event');
    try {
        let data = {};
        if (req.body && req.body.event_log) {
            data = tryParseJson(req.body.event_log);
        } else if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
            data = { ...req.body, AccessControllerEvent: tryParseJson(req.body.AccessControllerEvent) };
        }
        if ((!data || Object.keys(data).length === 0) && req.body && typeof req.body === 'object') {
            data = { ...req.body };
        }
        lastWebhookSnapshot = {
            at: new Date().toISOString(),
            contentType: req.headers['content-type'] || 'unknown',
            topLevelKeys: Object.keys(data || {}),
            extractedAccessEvent: extractAccessEvent(data)
        };
        const sourceIp =
            req.headers['x-source-ip'] ||
            req.headers['x-real-ip'] ||
            req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
            req.socket.remoteAddress?.replace('::ffff:', '') ||
            '';

        console.log('SOURCE IP:', sourceIp);

        await handleEvent(data, sourceIp);
        if (KAISEN_BOT_URL) {
            axios.post(KAISEN_BOT_URL, req.body).catch(() => { });
        }
        res.status(200).send('OK');
    } catch (err) {
        console.error('Handler error:', err.message);
        res.status(200).send('OK');
    }
});

app.get('/', (req, res) => res.send('Other team attendance bot is running'));
app.get('/debug-last-event', (req, res) => res.json(lastWebhookSnapshot || { message: 'No webhook received yet' }));

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Other team bot running on http://0.0.0.0:${PORT}`);
    console.log('Waiting for attendance events...\n');
    sendTelegram('🟢 Attendance bot started and listening for events');
    if (isGoogleSheetsEnabled()) {
        ensureGoogleSheetHeader(GOOGLE_SHEET_ID, GOOGLE_SHEET_NAME).then(() => {
            console.log('📄 Google Sheets logging is active.');
        }).catch((err) => console.error('Google Sheets startup check error:', err.message));
    } else {
        console.log('📄 Google Sheets logging is disabled (env vars missing).');
    }
});

setInterval(() => {
    runBreakOvertimeCheck().catch((err) => console.error('Break overtime check error:', err.message));
}, 60000);

setInterval(() => {
    runNoShowCheck().catch((err) => console.error('No-show check error:', err.message));
}, NO_SHOW_CHECK_INTERVAL_MS);